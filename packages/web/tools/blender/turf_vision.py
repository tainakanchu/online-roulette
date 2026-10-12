# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic turf vision; run with Blender background Python.

All construction dimensions use glTF/game coordinates (X right, Y up, Z front).
The preview-only checker, scale figure, ground, lights and cameras never export.
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

import bmesh
import bpy
from mathutils import Vector


# プレビュー画像と統計の出力先。環境変数 BLENDER_PREVIEW_DIR で変えられる（既定は OS の一時フォルダー）
OUT_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "vision"
MATERIAL_NAMES = ("FrameDark", "SteelGrey", "PanelBack", "Concrete", "Lamp")


def native(point):
    return Vector((point[0], -point[2], point[1]))


def game(point):
    return (point[0], point[2], -point[1])


def material(name, rgb, metallic=0.0, roughness=0.6, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*rgb, 1)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
    bsdf.inputs["Emission Strength"].default_value = emission
    return mat


class Builder:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.material_ids = []
        self.parts = {}

    def append(self, vertices, faces, mat, label=None):
        start = len(self.vertices)
        self.vertices.extend(tuple(v) for v in vertices)
        self.faces.extend(tuple(start + i for i in face) for face in faces)
        self.material_ids.extend([MATERIAL_NAMES.index(mat)] * len(faces))
        has_label = label is not None
        if has_label:
            self.parts[label] = (start, len(self.vertices))

    def box(self, center, size, mat="SteelGrey", bevel=0, label=None):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        for vertex in bm.verts:
            vertex.co = Vector(tuple(vertex.co[i] * size[i] for i in range(3)))
        has_bevel = bevel > 0
        if has_bevel:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect="EDGES")
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        self.append([v.co + Vector(center) for v in bm.verts],
                    [[v.index for v in face.verts] for face in bm.faces], mat, label)
        bm.free()

    def pipe(self, start, end, radius, mat="SteelGrey", sides=8):
        a, b = Vector(start), Vector(end)
        axis = (b - a).normalized()
        reference = Vector((0, 1, 0))
        is_vertical = abs(axis.dot(reference)) > 0.95
        if is_vertical:
            reference = Vector((1, 0, 0))
        u = axis.cross(reference).normalized()
        v = axis.cross(u)
        vertices = [p + radius * (u * math.cos(i * math.tau / sides) + v * math.sin(i * math.tau / sides))
                    for p in (a, b) for i in range(sides)]
        faces = [(i, (i + 1) % sides, (i + 1) % sides + sides, i + sides) for i in range(sides)]
        faces.extend([tuple(reversed(range(sides))), tuple(range(sides, sides * 2))])
        self.append(vertices, faces, mat)

    def finish(self, materials):
        mesh = bpy.data.meshes.new("TurfVisionStructure")
        mesh.from_pydata([native(p) for p in self.vertices], [], self.faces)
        for mat in materials:
            mesh.materials.append(mat)
        for face, mat_id in zip(mesh.polygons, self.material_ids):
            face.material_index = mat_id
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        obj = bpy.data.objects.new("TurfVisionStructure", mesh)
        bpy.context.collection.objects.link(obj)
        obj["screen_center"] = [0, 12, 0]
        obj["screen_size"] = [36, 14]
        return obj


def structure():
    m = Builder()
    # Exact square inner edges keep the opening independent of exterior bevels.
    for side, x in (("left", -18.6), ("right", 18.6)):
        m.box((x, 12, -1.025), (1.2, 14, 2.35), "FrameDark", label=side)
    # The front fascia drops below the body so a 1.2-wide frame can coexist
    # with the 4.2-high housing underside and the suspended 3.85-high deck.
    m.box((0, 4.4, 0), (38.4, 1.2, 0.30), "FrameDark", label="bottom")
    m.box((0, 4.6, -1.175), (38.4, 0.8, 2.05), "FrameDark", label="housing_bottom")
    m.box((0, 19.6, -1.025), (38.4, 1.2, 2.35), "FrameDark", label="top")
    m.box((0, 12, -0.10), (36, 14, 0.10), "FrameDark", label="backing")
    m.box((0, 12.2, -2.16), (38.4, 16.0, 0.08), "PanelBack")
    for x in (-19.14, 19.14):
        m.box((x, 12, 0.19), (0.12, 16.4, 0.08), bevel=0.006, label=f"trim_side_{x}")
        m.box((x, 12.2, -2.18), (0.12, 16.0, 0.12), bevel=0.015)
    for y in (3.86, 20.14):
        m.box((0, y, 0.19), (38.16, 0.12, 0.08), bevel=0.006)
    m.box((0, 20.23, -1.01), (38.7, 0.14, 2.62), bevel=0.035)
    # Horizontal folded seams are geometry, not an image texture.
    for i in range(26):
        m.box((0, 4.55 + i * 0.60, -2.25), (38.14, 0.075, 0.12), "PanelBack", label=f"back_seam_{i}")
    for x in (-12.8, -6.4, 0, 6.4, 12.8):
        m.box((x, 12.2, -2.225), (0.055, 15.9, 0.05), "PanelBack")

    pillars = (-15, -5, 5, 15)
    for x in pillars:
        m.box((x, 0.24, -1.15), (2.2, 0.48, 2.4), "Concrete", 0.07)
        m.box((x, 0.54, -1.15), (1.42, 0.12, 1.38), bevel=0.025)
        m.box((x, 2.4, -1.15), (0.94, 3.72, 0.90), bevel=0.045)
        m.box((x, 3.95, -1.15), (1.65, 0.26, 1.3), bevel=0.025)
        for dx in (-0.57, 0.57):
            for dz in (-0.52, 0.52):
                m.pipe((x + dx, 0.59, -1.15 + dz), (x + dx, 0.68, -1.15 + dz), 0.065, sides=6)
    m.box((0, 3.82, -1.28), (31.4, 0.34, 0.6), bevel=0.025)
    for a, b in zip(pillars, pillars[1:]):
        for low, high in ((a, b), (b, a)):
            m.pipe((low, 0.82, -1.66), (high, 3.80, -1.66), 0.105)
        m.box(((a + b) / 2, 2.31, -1.69), (0.42, 0.42, 0.09), bevel=0.025)

    # Open grating permits light through the deck at the inspection closeup.
    walkway_start = len(m.vertices)
    for z in (0.30, 1.10):
        m.box((0, 3.77, z), (38.4, 0.16, 0.07))
    for z in (0.48, 0.68, 0.88):
        m.box((0, 3.81, z), (38.4, 0.08, 0.032))
    for i in range(193):
        m.box((-19.2 + i * 0.2, 3.815, 0.70), (0.034, 0.07, 0.8), label=f"deck_grating_{i}")
    for i in range(17):
        x = -19.2 + i * 2.4
        m.pipe((x, 3.85, 1.1), (x, 4.815, 1.1), 0.034)
    for i in range(13):
        x = -18 + i * 3
        m.box((x, 3.925, -0.28), (0.09, 0.55, 0.09), label=f"hanger_{i}")
        m.box((x, 3.64, 0.43), (0.10, 0.10, 1.52))
        m.box((x, 4.185, -0.28), (0.24, 0.03, 0.24))
    for y in (4.335, 4.815):
        m.pipe((-19.2, y, 1.1), (19.2, y, 1.1), 0.035)
        for x in (-19.2, 19.2):
            m.pipe((x, y, 0.25), (x, y, 1.1), 0.035)
    m.box((0, 3.92, 1.09), (38.4, 0.14, 0.035))
    m.parts["front_walkway"] = (walkway_start, len(m.vertices))

    # Rear service landing connects a ground ladder to the access door.
    m.box((-15.5, 3.78, -2.85), (4.7, 0.14, 1.25))
    for x in (-17.8, -15.4, -13.2):
        m.pipe((x, 3.85, -3.42), (x, 4.815, -3.42), 0.035)
        m.pipe((x, 3.08, -1.75), (x, 3.68, -3.35), 0.065)
    for y in (4.335, 4.815):
        m.pipe((-17.8, y, -3.42), (-13.2, y, -3.42), 0.035)
    m.box((-14.6, 5.25, -2.27), (1.72, 2.78, 0.09), "FrameDark")
    m.box((-14.6, 5.25, -2.335), (1.55, 2.60, 0.08), "SteelGrey", 0.025)
    m.pipe((-14.04, 5.03, -2.41), (-14.04, 5.31, -2.41), 0.031)
    for y in (4.38, 6.06):
        m.box((-15.36, y, -2.405), (0.09, 0.16, 0.06))
    for x in (-17.35, -16.60):
        m.pipe((x, 0.18, -3.53), (x, 4.95, -3.53), 0.044)
        m.pipe((x, 3.98, -2.65), (x, 21.0, -2.65), 0.044)
        for y in (5.1, 8.8, 12.5, 16.2, 19.9):
            m.pipe((x, y, -2.2), (x, y, -2.65), 0.037)
    for i in range(13):
        m.pipe((-17.35, 0.38 + i * 0.30, -3.53), (-16.60, 0.38 + i * 0.30, -3.53), 0.031)
    for i in range(53):
        m.pipe((-17.35, 4.00 + i * 0.30, -2.65), (-16.60, 4.00 + i * 0.30, -2.65), 0.031)
    for x in (-7.5, 2.5, 12.5):
        m.box((x, 5.65, -2.64), (2.8, 1.65, 0.76), bevel=0.05)
        m.box((x, 4.74, -2.64), (3.05, 0.12, 0.92))
        m.pipe((x - 0.65, 5.65, -3.025), (x - 0.65, 5.65, -3.065), 0.58, "FrameDark", 20)
        m.pipe((x - 0.65, 5.65, -3.065), (x - 0.65, 5.65, -3.105), 0.13, sides=12)
        for i in range(9):
            dy = (i - 4) * 0.115
            extent = math.sqrt(0.55 ** 2 - dy ** 2)
            m.pipe((x - 0.65 - extent, 5.65 + dy, -3.11), (x - 0.65 + extent, 5.65 + dy, -3.11), 0.018, sides=6)
        for i in range(8):
            m.box((x + 0.77, 5.10 + i * 0.155, -3.04), (0.75, 0.045, 0.06), "PanelBack")
    for x in (-18.5, 18.5):
        m.pipe((x, 20.30, -1.3), (x, 22.15, -1.3), 0.028)
        m.pipe((x, 20.30, -0.15), (x, 20.44, -0.15), 0.14)
        m.pipe((x, 20.44, -0.15), (x, 20.66, -0.15), 0.105, "Lamp", 12)
        m.pipe((x, 20.66, -0.15), (x, 20.70, -0.15), 0.12, sides=12)
    return m


def bounds(points):
    points = list(points)
    return {"min": [round(min(p[i] for p in points), 6) for i in range(3)],
            "max": [round(max(p[i] for p in points), 6) for i in range(3)]}


def validate_aperture(builder, obj):
    parts = {name: bounds(game(obj.data.vertices[i].co) for i in range(start, end))
             for name, (start, end) in builder.parts.items()}
    left, right = parts["left"]["max"][0], parts["right"]["min"][0]
    bottom, top = parts["bottom"]["max"][1], parts["top"]["min"][1]
    actual = {"width": right - left, "height": top - bottom,
              "center": [(right + left) / 2, (top + bottom) / 2, 0],
              "frame_front_z": parts["left"]["max"][2],
              "backing_front_z": parts["backing"]["max"][2]}
    assert actual["width"] == 36 and actual["height"] == 14
    assert actual["center"] == [0, 12, 0]
    assert abs(actual["backing_front_z"] + 0.05) < 1e-6
    assert parts["backing"]["min"][:2] == [-18, 5]
    assert parts["backing"]["max"][:2] == [18, 19]
    return {**actual, "passed": True, "method": "Measured final mesh vertices of four frame members and backing; game coordinates"}


def validate_revision(builder, obj):
    parts = {name: bounds(game(obj.data.vertices[i].co) for i in range(start, end))
             for name, (start, end) in builder.parts.items()}
    widths = {name: round(parts[name]["max"][axis] - parts[name]["min"][axis], 6)
              for name, axis in (("left", 0), ("right", 0), ("bottom", 1), ("top", 1))}
    deck_top = parts["deck_grating_0"]["max"][1]
    rail_top = parts["front_walkway"]["max"][1]
    underside = parts["housing_bottom"]["min"][1]
    trim = parts["trim_side_-19.14"]
    trim_width = round(trim["max"][0] - trim["min"][0], 6)
    trim_projection = round(trim["max"][2] - parts["left"]["max"][2], 6)
    hanger_x = [(parts[f"hanger_{i}"]["min"][0] + parts[f"hanger_{i}"]["max"][0]) / 2 for i in range(13)]
    pitches = [round(b - a, 6) for a, b in zip(hanger_x, hanger_x[1:])]
    seam_pitch = round(parts["back_seam_1"]["min"][1] - parts["back_seam_0"]["min"][1], 6)
    assert all(abs(width - 1.2) < 1e-5 for width in widths.values()), widths
    assert abs(deck_top - 3.85) < 1e-6 and rail_top <= 4.850001
    assert underside == 4.2 and all(pitch == 3 for pitch in pitches)
    assert abs(trim_width - 0.12) < 1e-5 and abs(trim_projection - 0.08) < 1e-5
    assert seam_pitch == 0.6
    return {"passed": True, "frame_widths": widths, "deck_top_y": deck_top,
            "rail_top_y": rail_top, "screen_clearance_y": round(5 - rail_top, 6),
            "housing_underside_y": underside, "front_fascia_bottom_y": parts["bottom"]["min"][1],
            "hanger_count": len(hanger_x), "hanger_pitch": pitches[0],
            "trim_width": trim_width, "trim_front_projection": trim_projection,
            "back_seam_pitch": seam_pitch,
            "back_seam_projection": round(-2.2 - parts["back_seam_0"]["min"][2], 6),
            "method": "Measured final mesh component bounds; handrail radius included"}


def inspect_glb(path, obj):
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", raw)
    assert magic == b"glTF" and version == 2 and length == len(raw)
    json_length = struct.unpack_from("<I", raw, 12)[0]
    doc = json.loads(raw[20:20 + json_length])
    assert len(doc["nodes"]) == len(doc["meshes"]) == 1
    node = doc["nodes"][0]
    assert node["name"] == "TurfVisionStructure"
    assert not any(k in node for k in ("matrix", "rotation", "scale", "translation"))
    assert node["extras"]["screen_center"] == [0, 12, 0]
    assert node["extras"]["screen_size"] == [36, 14]
    assert set(m["name"] for m in doc["materials"]) == set(MATERIAL_NAMES)
    for key in ("images", "textures", "animations", "skins", "cameras"):
        assert not doc.get(key), key
    for extension in doc.get("extensionsUsed", []):
        assert "compression" not in extension and "lights" not in extension
    primitives = doc["meshes"][0]["primitives"]
    counts = {doc["materials"][p["material"]]["name"]: doc["accessors"][p["indices"]]["count"] // 3
              for p in primitives}
    triangles = sum(counts.values())
    vertices = sum(doc["accessors"][p["attributes"]["POSITION"]]["count"] for p in primitives)
    bb = bounds(doc["accessors"][p["attributes"]["POSITION"]][key] for p in primitives for key in ("min", "max"))
    assert triangles == len(obj.data.polygons) and triangles <= 20000
    assert len(raw) <= 1000000 and len(obj.modifiers) == 0
    source_bb = bounds(game(v.co) for v in obj.data.vertices)
    assert all(abs(a - b) < 0.00001 for key in bb for a, b in zip(bb[key], source_bb[key]))
    return {"triangles": triangles, "vertices": vertices, "mesh_vertices": len(obj.data.vertices),
            "bounding_box": bb, "material_triangles": counts, "glb_bytes": len(raw),
            "glb_sha256": hashlib.sha256(raw).hexdigest(), "node_count": 1,
            "extras": node["extras"], "export_checks_passed": True}


def render_previews(out_dir, samples):
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
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes.get("Background").inputs["Color"].default_value = (0.40, 0.65, 0.85, 1)
    world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0.7
    grass = material("PreviewGrass", (0.17, 0.29, 0.065), roughness=1)
    bpy.ops.mesh.primitive_plane_add(size=20000, location=native((0, -0.015, 0)))
    bpy.context.object.data.materials.append(grass)
    checker = material("PreviewChecker", (1, 1, 1), emission=0.7)
    nodes, links = checker.node_tree.nodes, checker.node_tree.links
    coords = nodes.new("ShaderNodeTexCoord")
    texture = nodes.new("ShaderNodeTexChecker")
    texture.inputs["Color1"].default_value = (0.13, 0.65, 0.84, 1)
    texture.inputs["Color2"].default_value = (1.0, 0.77, 0.28, 1)
    texture.inputs["Scale"].default_value = 0.5
    links.new(coords.outputs["Object"], texture.inputs["Vector"])
    for key in ("Base Color", "Emission Color"):
        links.new(texture.outputs["Color"], nodes.get("Principled BSDF").inputs[key])
    mesh = bpy.data.meshes.new("PreviewScreen")
    mesh.from_pydata([native(p) for p in ((-18, 5, 0), (18, 5, 0), (18, 19, 0), (-18, 19, 0))], [], [(0, 1, 2, 3)])
    screen = bpy.data.objects.new("PreviewScreen", mesh)
    bpy.context.collection.objects.link(screen)
    mesh.materials.append(checker)
    figure = material("PreviewFigure", (0.65, 0.15, 0.035))
    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.23, depth=1.55, location=native((-10.5, 0.775, 1.8)))
    bpy.context.object.data.materials.append(figure)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.225, location=native((-10.5, 1.775, 1.8)))
    bpy.context.object.data.materials.append(figure)
    sun = bpy.data.lights.new("PreviewSun", "SUN")
    sun.energy = 2.5
    sun.angle = math.radians(10)
    sun_obj = bpy.data.objects.new("PreviewSun", sun)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = native((3, -7, -5)).to_track_quat("-Z", "Y").to_euler()
    camera = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = "PERSP"
    camera.data.sensor_fit = "HORIZONTAL"
    camera.data.clip_end = 20000

    def render(filename, position, target, scale, width=1280):
        camera.location = native(position)
        camera.rotation_euler = (native(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.lens = camera.data.sensor_width * (native(target) - camera.location).length / scale
        scene.render.resolution_x = width
        scene.render.resolution_y = 640
        scene.render.filepath = str(out_dir / filename)
        bpy.ops.render.render(write_still=True)

    render("front.png", (0, 11, 80), (0, 11, 0), 48)
    render("three_quarter.png", (38, 19, 56), (0, 10.6, -0.6), 54)
    sun_obj.rotation_euler = native((-3, -7, 5)).to_track_quat("-Z", "Y").to_euler()
    render("back.png", (-36, 19, -55), (0, 10.4, -1), 54)
    sun_obj.rotation_euler = native((3, -7, -5)).to_track_quat("-Z", "Y").to_euler()
    render("closeup.png", (-26, 9, 15), (-16.7, 5.0, 0.1), 7.3, 640)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "public/models/turf-vision.glb")
    parser.add_argument("--preview-dir", type=Path, default=OUT_DIR)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--skip-previews", action="store_true")
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parser.parse_args(arguments)
    started = time.perf_counter()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    materials = [material("FrameDark", (0.025, 0.033, 0.041), 0.30),
                 material("SteelGrey", (0.62, 0.67, 0.72), 0.45, 0.38),
                 material("PanelBack", (0.23, 0.28, 0.31), 0.45, 0.52),
                 material("Concrete", (0.42, 0.41, 0.37), roughness=0.95),
                 material("Lamp", (0.8, 0.008, 0.003), roughness=0.26, emission=2)]
    builder = structure()
    obj = builder.finish(materials)
    aperture = validate_aperture(builder, obj)
    revision = validate_revision(builder, obj)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.preview_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(args.output), export_format="GLB", use_selection=True,
                              export_yup=True, export_extras=True, export_animations=False,
                              export_cameras=False, export_lights=False, export_texcoords=False,
                              export_normals=True, export_materials="EXPORT")
    stats = inspect_glb(args.output, obj)
    stats["opening_validation"] = aperture
    stats["revision_validation"] = revision
    stats["model_generation_seconds"] = round(time.perf_counter() - started, 3)
    should_render = not args.skip_previews
    if should_render:
        render_previews(args.preview_dir, args.samples)
    stats["generation_seconds"] = round(time.perf_counter() - started, 3)
    stats["blender_version"] = bpy.app.version_string
    stats["preview_renderer"] = {"engine": "CYCLES", "device": "CPU", "samples": args.samples, "rendered": should_render}
    stats["coordinate_system"] = "+X width, +Y up, +Z screen front; origin at ground"
    encoded = json.dumps(stats, indent=2, ensure_ascii=False)
    (args.preview_dir / "stats.json").write_text(encoded + "\n", encoding="utf-8")
    print(encoded, flush=True)


if __name__ == "__main__":
    main()
