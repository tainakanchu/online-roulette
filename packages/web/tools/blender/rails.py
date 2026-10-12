# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Generate repeatable rail modules with Blender's bundled Python.

Coordinates in this script and stats are glTF/game coordinates: X forward,
Y up, +Z toward the track. Blender stores (X, -Z, Y). Rail endpoints have
identical radial normals, so translated modules join seamlessly.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import time

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[4]
# プレビュー画像と統計の出力先。環境変数 BLENDER_PREVIEW_DIR で変えられる（既定は OS の一時フォルダー）
PREVIEW = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "rails"
PITCH = 3.0
TOP_CENTER = 1.045
TOP_RADIUS = 0.055
INNER_TOP_CENTER = 1.037
INNER_TOP_RADII = (0.063, 0.057)
PIPE_SIDES = 12
INNER_BEND_SEGMENTS = 9


def native(point):
    return Vector((point[0], -point[2], point[1]))


def material(name, color, roughness, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*color, 1)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return mat


class Builder:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.material_ids = []
        self.smooth = []

    def add(self, vertices, faces, material_id=0, smooth=False):
        offset = len(self.vertices)
        self.vertices.extend(vertices)
        self.faces.extend(tuple(offset + i for i in face) for face in faces)
        self.material_ids.extend([material_id] * len(faces))
        self.smooth.extend([smooth] * len(faces))

    def tube(self, points, radius, sides=PIPE_SIDES, caps=(True, True),
             material_id=0, angle_start=0, angle_span=math.tau):
        points = [Vector(p) for p in points]
        is_elliptical = isinstance(radius, tuple)
        radius_u, radius_v = radius if is_elliptical else (radius, radius)
        is_closed = math.isclose(angle_span, math.tau)
        ring_size = sides if is_closed else sides + 1
        vertices = []
        for index, point in enumerate(points):
            tangent = (points[min(index + 1, len(points) - 1)]
                       - points[max(0, index - 1)]).normalized()
            is_longitudinal = abs(tangent.x) > 0.99
            u = Vector((0, 1, 0)) if is_longitudinal else Vector((1, 0, 0))
            v = tangent.cross(u).normalized()
            vertices.extend(tuple(point
                + radius_u * u * math.cos(angle_start + i * angle_span / sides)
                + radius_v * v * math.sin(angle_start + i * angle_span / sides)
            ) for i in range(ring_size))
        faces = []
        for ring in range(len(points) - 1):
            for i in range(sides):
                a = ring * ring_size + i
                b = ring * ring_size + (i + 1) % ring_size
                faces.append((a, b, b + ring_size, a + ring_size))
        self.add(vertices, faces, material_id, True)
        # Separate cap normals prevent flattened shading on pipe sides.
        has_start_cap, has_end_cap = caps
        if has_start_cap:
            self.add(vertices[:sides], [tuple(reversed(range(sides)))], material_id)
        if has_end_cap:
            self.add(vertices[-sides:], [tuple(range(sides))], material_id)

    def plate(self, z):
        vertices = [(x, y, z + dz) for x in (-0.065, 0.065)
                    for y in (-0.008, 0.006) for dz in (-0.065, 0.065)]
        # The buried underside cannot be seen and would consume the bend budget.
        self.add(vertices, [(0, 1, 3, 2), (4, 6, 7, 5),
                            (2, 3, 7, 6),
                            (0, 2, 6, 4), (1, 5, 7, 3)], 1)

    def round_cap(self):
        latitude_rings = 3
        vertices = [(0.05 * math.cos(a) * math.cos(b),
                     1.078 + 0.05 * math.sin(b),
                     0.05 * math.sin(a) * math.cos(b))
                    for b in (i * math.pi / 6 for i in range(latitude_rings))
                    for a in (i * math.tau / PIPE_SIDES for i in range(PIPE_SIDES))]
        vertices.append((0, 1.128, 0))
        faces = []
        for i in range(PIPE_SIDES):
            j = (i + 1) % PIPE_SIDES
            for ring in range(latitude_rings - 1):
                offset = ring * PIPE_SIDES
                faces.append((offset + i, offset + i + PIPE_SIDES,
                              offset + j + PIPE_SIDES, offset + j))
            offset = (latitude_rings - 1) * PIPE_SIDES
            faces.append((offset + i, latitude_rings * PIPE_SIDES, offset + j))
        self.add(vertices, faces, smooth=True)

    def finish(self, name, materials):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([native(p) for p in self.vertices], [], self.faces)
        for mat in materials:
            mesh.materials.append(mat)
        for polygon, mat_id, smooth in zip(mesh.polygons, self.material_ids, self.smooth):
            polygon.material_index = mat_id
            polygon.use_smooth = smooth
        mesh.update()
        # Store the quad surface normals before triangulation; a diagonal must
        # not bias endpoint normals differently at either end of a module.
        normals = [tuple(n.vector) for n in mesh.corner_normals]
        mesh.normals_split_custom_set(normals)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj["repeat_pitch"] = PITCH
        obj["track_side"] = "+Z"
        return obj


def build_modules():
    materials = [material("RailWhite", (0.88, 0.90, 0.92), 0.34),
                 material("RailBase", (0.075, 0.085, 0.10), 0.65, 0.25)]
    inner = Builder()
    # One end cap closes each assembled joint without overlapping cap faces.
    inner.tube([(0, INNER_TOP_CENTER, 0), (PITCH, INNER_TOP_CENTER, 0)],
               INNER_TOP_RADII, caps=(True, False))
    controls = [Vector(p) for p in ((0, 0.59, -0.45), (0, 0.81, -0.45),
                                   (0, 0.945, -0.15), (0, 1.017, 0))]
    points = [(0, 0, -0.45)]
    for i in range(INNER_BEND_SEGMENTS + 1):
        t = i / INNER_BEND_SEGMENTS
        points.append((1 - t) ** 3 * controls[0]
                      + 3 * (1 - t) ** 2 * t * controls[1]
                      + 3 * (1 - t) * t ** 2 * controls[2] + t ** 3 * controls[3])
    inner.tube(points, 0.041, caps=(False, False))
    # A 240-degree saddle leaves the underside open for the support connection.
    # A full sleeve would hide that connection and exceed the 300-triangle limit.
    inner.tube([(-0.035, INNER_TOP_CENTER, 0), (0.035, INNER_TOP_CENTER, 0)],
               (0.069, 0.063), sides=8, caps=(False, False), material_id=1,
               angle_start=-2 * math.pi / 3, angle_span=4 * math.pi / 3)
    inner.plate(-0.45)
    outer = Builder()
    outer.tube([(0, TOP_CENTER, 0), (PITCH, TOP_CENTER, 0)], TOP_RADIUS)
    outer.tube([(0, 0.55, 0), (PITCH, 0.55, 0)], 0.034)
    outer.tube([(0, 0, 0), (0, 1.08, 0)], 0.043, caps=(False, False))
    outer.round_cap()
    for height, radius in ((TOP_CENTER, 0.061), (0.55, 0.040)):
        outer.tube([(-0.035, height, 0), (0.035, height, 0)], radius,
                   caps=(False, False), material_id=1)
    outer.plate(0)
    return [inner.finish("InnerRailSegment", materials),
            outer.finish("OuterRailSegment", materials)]


def read_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data)
    assert magic == b"glTF" and version == 2 and length == len(data)
    json_length, json_kind = struct.unpack_from("<I4s", data, 12)
    assert json_kind == b"JSON"
    document = json.loads(data[20:20 + json_length])
    binary_offset = 20 + json_length
    binary_length, binary_kind = struct.unpack_from("<I4s", data, binary_offset)
    assert binary_kind == b"BIN\x00"
    binary = data[binary_offset + 8:binary_offset + 8 + binary_length]

    def accessor(index):
        entry = document["accessors"][index]
        view = document["bufferViews"][entry["bufferView"]]
        count = {"SCALAR": 1, "VEC3": 3}[entry["type"]]
        code = {5123: "H", 5125: "I", 5126: "f"}[entry["componentType"]]
        fmt = "<" + count * code
        stride = view.get("byteStride", struct.calcsize(fmt))
        offset = view.get("byteOffset", 0) + entry.get("byteOffset", 0)
        return [struct.unpack_from(fmt, binary, offset + i * stride)
                for i in range(entry["count"])]

    nodes = {}
    seams = {}
    budgets = {"InnerRailSegment": 300, "OuterRailSegment": 250}
    for node in document["nodes"]:
        mesh = document["meshes"][node["mesh"]]
        positions, normals = [], []
        triangles = 0
        for primitive in mesh["primitives"]:
            assert primitive.get("mode", 4) == 4
            positions.extend(accessor(primitive["attributes"]["POSITION"]))
            normals.extend(accessor(primitive["attributes"]["NORMAL"]))
            triangles += len(accessor(primitive["indices"])) // 3
        nodes[node["name"]] = {
            "triangles": triangles, "vertices": len(positions),
            "bounding_box": {
                "min": [round(min(p[i] for p in positions), 6) for i in range(3)],
                "max": [round(max(p[i] for p in positions), 6) for i in range(3)],
            },
            "origin": node.get("translation", [0, 0, 0]),
            "mesh_primitives": len(mesh["primitives"]),
        }
        assert triangles <= budgets[node["name"]]
        is_outer = node["name"] == "OuterRailSegment"
        levels = [(INNER_TOP_CENTER, *INNER_TOP_RADII)]
        if is_outer:
            levels = [(TOP_CENTER, TOP_RADIUS, TOP_RADIUS), (0.55, 0.034, 0.034)]
        checks = []
        for level, radius_y, radius_z in levels:
            rings = []
            for endpoint in (0, PITCH):
                ring = [(p, n) for p, n in zip(positions, normals)
                        if abs(p[0] - endpoint) < 1e-6
                        and abs(p[1] - level) <= radius_y + 1e-6
                        and abs(p[2]) <= radius_z + 1e-6
                        and abs(math.hypot((p[1] - level) / radius_y, p[2] / radius_z) - 1) < 2e-6
                        and abs(n[0]) < 1e-6]
                rings.append(sorted(ring, key=lambda item: (item[0][1], item[0][2])))
            assert len(rings[0]) == len(rings[1]) == PIPE_SIDES
            position_error = max(math.dist((a[0][0] + PITCH, *a[0][1:]), b[0])
                                 for a, b in zip(*rings))
            normal_error = max(math.dist(a[1], b[1]) for a, b in zip(*rings))
            assert position_error < 1e-6 and normal_error < 1e-6
            checks.append({"center_y": level, "ring_vertices": PIPE_SIDES,
                           "max_position_error": position_error,
                           "max_normal_error": normal_error, "passed": True})
        seams[node["name"]] = checks
    assert set(nodes) == set(budgets)
    assert {mat["name"] for mat in document["materials"]} == {"RailWhite", "RailBase"}
    for forbidden in ("textures", "images", "animations", "cameras", "skins", "extensionsUsed"):
        assert not document.get(forbidden), forbidden
    assert len(data) <= 200_000
    return nodes, seams


def render_previews(modules, out_dir, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = True
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("PreviewSky")
    world.use_nodes = True
    world.node_tree.nodes.get("Background").inputs["Color"].default_value = (0.40, 0.67, 0.90, 1)
    world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0.65
    scene.world = world
    grass = material("PreviewGrass", (0.16, 0.28, 0.075), 0.95)
    bpy.ops.mesh.primitive_plane_add(size=200, location=(18, 0, 0))
    bpy.context.object.name = "PreviewGround"
    bpy.context.object.data.materials.append(grass)
    light = bpy.data.lights.new("PreviewSun", "SUN")
    light.energy = 2.4
    light.angle = math.radians(9)
    sun = bpy.data.objects.new("PreviewSun", light)
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = native((-3, -7, -4)).to_track_quat("-Z", "Y").to_euler()
    camera = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = "PERSP"
    camera.data.sensor_fit = "HORIZONTAL"
    camera.data.clip_end = 500
    groups = []
    for module in modules:
        module.hide_render = True
        group = []
        for index in range(12):
            instance = bpy.data.objects.new(f"Preview_{module.name}_{index:02}", module.data)
            bpy.context.collection.objects.link(instance)
            instance.location = native((index * PITCH, 0, 0))
            instance.hide_render = True
            group.append(instance)
        groups.append(group)

    def render(name, position, target, width, height, lens):
        camera.location = native(position)
        camera.rotation_euler = (native(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.lens = lens
        scene.render.resolution_x = width
        scene.render.resolution_y = height
        scene.render.filepath = str(out_dir / name)
        bpy.ops.render.render(write_still=True)

    for index, label in enumerate(("inner", "outer")):
        for group_index, group in enumerate(groups):
            for instance in group:
                instance.hide_render = group_index != index
        render(f"{label}_overview.png", (-7, 3.6, 11), (9, 0.53, 0), 1280, 640, 35)
        render(f"{label}_closeup.png", (12.6, 1.65, 3.2), (15.35, 0.55, -0.18), 640, 640, 65)
    for group_index, group in enumerate(groups):
        for index, instance in enumerate(group):
            instance.hide_render = group_index != 0 or index != 0
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 1.48
    render("inner_profile.png", (-5, 0.55, -0.20), (0, 0.55, -0.20), 640, 640, 50)


def main():
    started = time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "packages/web/public/models/rails.glb")
    parser.add_argument("--preview-dir", type=Path, default=PREVIEW)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--skip-previews", action="store_true")
    has_args = "--" in sys.argv
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if has_args else [])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.preview_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    modules = build_modules()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in modules:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = modules[0]
    bpy.ops.export_scene.gltf(
        filepath=str(args.output), export_format="GLB", use_selection=True,
        export_yup=True, export_animations=False, export_cameras=False,
        export_lights=False, export_texcoords=False, export_normals=True,
        export_materials="EXPORT", export_extras=True,
        export_draco_mesh_compression_enable=False,
    )
    nodes, seams = read_glb(args.output)
    for obj in modules:
        nodes[obj.name]["source_vertices"] = len(obj.data.vertices)
    should_render = not args.skip_previews
    if should_render:
        render_previews(modules, args.preview_dir, args.samples)
    stats = {
        "blender_version": bpy.app.version_string,
        "coordinate_system": "+X forward, +Y up, +Z track side",
        "repeat_pitch": PITCH, "top_height": 1.1,
        "pipe_cross_section_sides": PIPE_SIDES,
        "inner_handrail_diameters_yz": [2 * r for r in INNER_TOP_RADII],
        "inner_bend_segments": INNER_BEND_SEGMENTS,
        "inner_bend_segments_previous": 6,
        "base_plate_size": [0.13, 0.014, 0.13],
        "inner_post_root_z": -0.45,
        "nodes": nodes, "endpoint_validation": seams,
        "glb_bytes": args.output.stat().st_size,
        "glb_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "glb_path": str(args.output.resolve()),
        "preview_renderer": "Cycles CPU", "preview_samples": args.samples,
        "previews_rendered": should_render, "preview_instances_per_type": 12,
        "validation": {"budgets_passed": True, "two_mesh_nodes": True,
                       "two_materials": True, "no_textures_animation_camera_lights": True,
                       "uncompressed": True, "seam_positions_and_normals_match": True},
        "notes": ["Vertex counts are exported glTF vertices including normal/material splits.",
                  "Support and base are centered at x=0; their thickness extends to negative x.",
                  "Rail caps use separate flat normals; side normals match exactly across repeated modules.",
                  "Inner bend uses 9 spans instead of 6; 12 spans with 12 sides exceed the budget before adding rails or fittings.",
                  "Inner clamp is a 240-degree saddle with an open underside; hidden support end caps and buried base undersides are omitted.",
                  "top_height describes the handrail; clamps and the outer dome extend slightly above it."],
        "generation_seconds": round(time.perf_counter() - started, 3),
    }
    report = json.dumps(stats, indent=2)
    (args.preview_dir / "stats.json").write_text(report + "\n")
    print(report, flush=True)


is_main = __name__ == "__main__"
if is_main:
    main()
