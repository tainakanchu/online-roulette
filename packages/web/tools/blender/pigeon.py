# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic pigeon, authored in game coordinates (+X forward, +Y up).

Run with Blender -b --factory-startup -noaudio --python pigeon.py -- [options].
All exported transforms are identity. Joint-local meshes must be translated by
PigeonBody's game-coordinate extras when assembling the bird in three.js.
COLOR_0 alpha is an iridescence mask, NOT opacity; keep materials opaque.
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
from mathutils import Matrix, Vector


ROOT = Path(__file__).resolve().parents[4]
# プレビュー画像と統計の出力先。環境変数 BLENDER_PREVIEW_DIR で変えられる（既定は OS の一時フォルダー）
PREVIEW_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "pigeon"
JOINTS = {
    "head_joint": [0.062, 0.199, 0.0],
    "shoulder_left": [0.025, 0.204, 0.049],
    "shoulder_right": [0.025, 0.204, -0.049],
    "tail_joint": [-0.128, 0.157, 0.0],
}
PART_JOINTS = {
    "PigeonHead": "head_joint",
    "PigeonWingL": "shoulder_left",
    "PigeonWingR": "shoulder_right",
    "PigeonTailFolded": "tail_joint",
    "PigeonTailSpread": "tail_joint",
}
LIMITS = {
    "PigeonBody": 300, "PigeonHead": 220, "PigeonLegs": 80,
    "PigeonWingsFolded": 160, "PigeonWingL": 160, "PigeonWingR": 160,
    "PigeonTailFolded": 48, "PigeonTailSpread": 80,
}
GRAY = (0.29, 0.35, 0.43, 0.0)
PALE = (0.43, 0.49, 0.56, 0.0)
DARK = (0.024, 0.031, 0.043, 0.0)
FLIGHT = (0.105, 0.13, 0.17, 0.0)
RUMP = (0.66, 0.70, 0.72, 0.0)


def game_to_blender(point):
    x, y, z = point
    return Vector((x, -z, y))


def blender_to_game(point):
    return (point[0], point[2], -point[1])


def tint(color, scale):
    return tuple(v * scale for v in color[:3]) + (color[3],)


class Mesh:
    def __init__(self, name):
        self.name = name
        self.vertices = []
        self.faces = []
        self.colors = []
        self.materials = []

    def add(self, vertices, faces, color, material="Feather", colors=None):
        offset = len(self.vertices)
        self.vertices.extend(Vector(v) for v in vertices)
        self.faces.extend(tuple(offset + i for i in face) for face in faces)
        self.colors.extend(colors if colors is not None else [color] * len(vertices))
        self.materials.extend([material] * len(faces))

    def ellipsoid(self, center, radii, color, segments=10, bands=5, material="Feather"):
        vertices = [(center[0], center[1] + radii[1], center[2])]
        for row in range(1, bands):
            phi = math.pi * row / bands
            for column in range(segments):
                theta = math.tau * column / segments
                vertices.append((
                    center[0] + radii[0] * math.sin(phi) * math.cos(theta),
                    center[1] + radii[1] * math.cos(phi),
                    center[2] + radii[2] * math.sin(phi) * math.sin(theta),
                ))
        vertices.append((center[0], center[1] - radii[1], center[2]))
        faces = []
        for column in range(segments):
            nxt = (column + 1) % segments
            faces.append((0, 1 + nxt, 1 + column))
            for row in range(bands - 2):
                a = 1 + row * segments + column
                b = 1 + row * segments + nxt
                faces.append((a, b, b + segments, a + segments))
            a = 1 + (bands - 2) * segments + column
            b = 1 + (bands - 2) * segments + nxt
            faces.append((len(vertices) - 1, a, b))
        self.add(vertices, faces, color, material)

    def loft(self, rows, segments, tone):
        vertices, colors, faces = [], [], []
        for row, (x, y, rx, rz) in enumerate(rows):
            for column in range(segments):
                angle = math.tau * column / segments
                point = (x + rx * math.cos(angle), y, rz * math.sin(angle))
                vertices.append(point)
                colors.append(tone(row, angle))
        for row in range(len(rows) - 1):
            for column in range(segments):
                a = row * segments + column
                b = row * segments + (column + 1) % segments
                faces.append((a, a + segments, b + segments, b))
        faces.extend([tuple(range(segments)), tuple(reversed(range(len(vertices) - segments, len(vertices))))])
        self.add(vertices, faces, GRAY, colors=colors)

    def tube(self, start, end, radius, color, sides=4):
        a, b = Vector(start), Vector(end)
        direction = (b - a).normalized()
        reference = Vector((1, 0, 0))
        is_parallel = abs(direction.dot(reference)) > 0.9
        if is_parallel:
            reference = Vector((0, 0, 1))
        u = direction.cross(reference).normalized()
        v = direction.cross(u)
        vertices = []
        for center, width in ((a, radius), (b, radius * 0.72)):
            for i in range(sides):
                theta = math.tau * i / sides
                vertices.append(center + width * (u * math.cos(theta) + v * math.sin(theta)))
        faces = [(i, (i + 1) % sides, (i + 1) % sides + sides, i + sides) for i in range(sides)]
        # Open ends are buried in adjoining geometry; caps waste the leg budget.
        self.add(vertices, faces, color, "Leg")

    def sheet(self, vertices, faces, color, colors=None):
        upward_faces = []
        for face in faces:
            a, b, c = (Vector(vertices[index]) for index in face[:3])
            is_downward = (b - a).cross(c - a).y < 0
            upward_faces.append(tuple(reversed(face)) if is_downward else face)
        self.add(vertices, upward_faces, color, colors=colors)

    def finish(self, materials):
        joint_name = PART_JOINTS.get(self.name)
        joint = Vector(JOINTS[joint_name]) if joint_name else Vector((0, 0, 0))
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata([game_to_blender(v - joint) for v in self.vertices], [], self.faces)
        mesh.update()
        attribute = mesh.color_attributes.new(name="COLOR_0", type="FLOAT_COLOR", domain="POINT")
        for entry, color in zip(attribute.data, self.colors):
            entry.color = color
        names = list(dict.fromkeys(self.materials))
        for name in names:
            mesh.materials.append(materials[name])
        for polygon, name in zip(mesh.polygons, self.materials):
            polygon.use_smooth = True
            polygon.material_index = names.index(name)
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.collection.objects.link(obj)
        mesh.calc_loop_triangles()
        assert len(mesh.loop_triangles) <= LIMITS[self.name], (self.name, len(mesh.loop_triangles))
        return obj


def create_materials():
    materials = {}
    for name in ("Feather", "Beak", "Eye", "Leg"):
        material = bpy.data.materials.new(name)
        material.use_nodes = True
        material.diffuse_color = (1, 1, 1, 1)
        material.use_backface_culling = False
        nodes = material.node_tree.nodes
        shader = nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (1, 1, 1, 1)
        shader.inputs["Roughness"].default_value = 0.62 if name == "Feather" else 0.37
        vertex = nodes.new("ShaderNodeVertexColor")
        vertex.layer_name = "COLOR_0"
        material.node_tree.links.new(vertex.outputs["Color"], shader.inputs["Base Color"])
        # Alpha is data, so connecting it to opacity would make most feathers invisible.
        is_feather = name == "Feather"
        if is_feather:
            material.node_tree.links.new(vertex.outputs["Alpha"], shader.inputs["Metallic"])
        materials[name] = material
    return materials


def make_body():
    mesh = Mesh("PigeonBody")
    mesh.ellipsoid((-0.023, 0.163, 0), (0.151, 0.092, 0.074), GRAY, 16, 10)
    for index, point in enumerate(mesh.vertices):
        is_rump = point.x < -0.083 and point.y > 0.192 and abs(point.z) < 0.038
        if is_rump:
            mesh.colors[index] = RUMP
    return mesh


def make_head():
    mesh = Mesh("PigeonHead")
    rows = [(0.052, 0.182, 0.063, 0.047), (0.070, 0.217, 0.060, 0.045),
            (0.085, 0.249, 0.049, 0.039), (0.099, 0.280, 0.034, 0.032),
            (0.113, 0.310, 0.028, 0.029)]

    def neck_tone(row, angle):
        strength = (0.0, 0.42, 1.0, 0.48, 0.0)[row]
        hue = (1 - math.cos(angle)) * 0.5
        hue = hue * hue * (3 - 2 * hue)
        green, purple = (0.045, 0.25, 0.17), (0.19, 0.080, 0.22)
        base = (0.20, 0.26, 0.33) if row < 2 else (0.15, 0.20, 0.26)
        color = tuple(base[i] * (1 - strength) +
                      (green[i] * (1 - hue) + purple[i] * hue) * strength for i in range(3))
        return (*color, strength * (0.95 - hue * 0.10))

    mesh.loft(rows, 8, neck_tone)
    head_start = len(mesh.vertices)
    mesh.ellipsoid((0.121, 0.316, 0), (0.047, 0.044, 0.038), (0.15, 0.20, 0.26, 0), 10, 6)
    for point in mesh.vertices[head_start:]:
        forward = max(0, (point.x - 0.121) / 0.047)
        forehead = math.exp(-((point.y - 0.325) / 0.021) ** 2)
        point.x += 0.006 * forward * forehead
    mesh.ellipsoid((0.177, 0.307, 0), (0.028, 0.009, 0.011), (0.055, 0.052, 0.055, 0), 4, 2, "Beak")
    mesh.ellipsoid((0.164, 0.315, 0), (0.014, 0.009, 0.014), (0.78, 0.78, 0.71, 0), 4, 2, "Beak")
    for side in (-1, 1):
        for radius, offset, color in ((0.0082, 0, (0.92, 0.23, 0.016, 0)),
                                      (0.0041, 0.0008, (0.006, 0.007, 0.009, 0))):
            center = Vector((0.137, 0.323, side * (0.0375 + offset)))
            vertices = [center]
            vertices.extend(center + Vector((radius * math.cos(i * math.tau / 6), radius * math.sin(i * math.tau / 6), 0)) for i in range(6))
            faces = [(0, i + 1, (i + 1) % 6 + 1) for i in range(6)]
            is_right = side < 0
            if is_right:
                faces = [tuple(reversed(face)) for face in faces]
            mesh.add(vertices, faces, color, "Eye")
    return mesh


def make_legs():
    mesh = Mesh("PigeonLegs")
    color = (0.48, 0.12, 0.14, 0)
    for side in (-1, 1):
        z = side * 0.038
        mesh.tube((0.0, 0.103, z), (-0.015, 0.044, z), 0.007, color)
        mesh.tube((-0.015, 0.044, z), (0.008, 0.011, z), 0.0058, color)
        for end in ((0.058, 0.0038, z), (0.043, 0.0038, z + 0.022),
                    (0.042, 0.0038, z - 0.022), (-0.041, 0.0038, z - side * 0.009)):
            mesh.tube((0.006, 0.009, z), end, 0.0046, tint(color, 0.88), sides=3)
    ground_offset = min(point.y for point in mesh.vertices)
    for point in mesh.vertices:
        point.y -= ground_offset
    return mesh


def folded_point(t, angle, side, lift=0):
    width = math.sin(math.pi * t) ** 0.8
    return (-0.217 + 0.292 * t, 0.158 + 0.026 * t + (0.053 + lift) * width * math.cos(angle),
            side * (0.047 + (0.032 + lift) * width * math.sin(angle)))


def make_folded_wings():
    mesh = Mesh("PigeonWingsFolded")
    rows = (0.14, 0.21, 0.22, 0.31, 0.32, 0.41, 0.42, 0.51, 0.52, 0.91)
    angles = (-0.25, 0.55, 1.35, 2.15)
    for side in (-1, 1):
        vertices = [folded_point(0, 0, side)]
        # A black folded tip reads as an extra bar; reserve black for two paired rows.
        tip_color = (0.20, 0.25, 0.31, 0.0)
        colors = [tip_color]
        for t in rows:
            is_band = t in (0.22, 0.31, 0.42, 0.51)
            color = DARK if is_band else (tip_color if t == rows[0] else PALE)
            for angle in angles:
                sweep = 0.12 * (angle + 0.25) / 2.4 * math.sin(math.pi * t)
                vertices.append(folded_point(t - sweep, angle, side))
                colors.append(color)
        vertices.append(folded_point(1, 0, side))
        colors.append(PALE)
        faces = []
        for column in range(3):
            faces.append((0, 1 + column, 2 + column))
            for row in range(len(rows) - 1):
                a = 1 + row * 4 + column
                faces.append((a, a + 4, a + 5, a + 1))
            a = 1 + (len(rows) - 1) * 4 + column
            faces.append((len(vertices) - 1, a + 1, a))
        is_left = side > 0
        if is_left:
            faces = [tuple(reversed(face)) for face in faces]
        mesh.add(vertices, faces, PALE, colors=colors)
    return mesh


def primary_feather(mesh, root, tip, width):
    root, tip = Vector(root), Vector(tip)
    axis = tip - root
    across = Vector((-axis.z, 0, axis.x)).normalized() * width * 0.5
    vertices, colors = [], []
    for fraction, taper, tone in ((0, 0.65, FLIGHT), (0.62, 1.0, FLIGHT),
                                  (0.88, 0.75, DARK), (0.97, 0.38, DARK)):
        center = root + axis * fraction
        vertices.extend((center - across * taper, center + across * taper))
        colors.extend((tone, tone))
    vertices.append(tip)
    colors.append(DARK)
    mesh.sheet(vertices, [(0, 1, 3, 2), (2, 3, 5, 4), (4, 5, 7, 6), (6, 7, 8)], FLIGHT, colors)


def make_wing(side):
    mesh = Mesh("PigeonWingL" if side > 0 else "PigeonWingR")
    shoulder = Vector(JOINTS["shoulder_left" if side > 0 else "shoulder_right"])

    def point(x, span, height=0):
        return shoulder + Vector((x, height, span * side))

    primary_roots = ((0.025, 0.23), (-0.006, 0.24), (-0.038, 0.26),
                     (-0.070, 0.27), (-0.100, 0.28))
    primary_tips = ((0.010, 0.449), (-0.042, 0.440), (-0.093, 0.421),
                    (-0.139, 0.389), (-0.178, 0.350))
    for root, tip in zip(primary_roots, primary_tips):
        primary_feather(mesh, point(*root, -0.003), point(*tip, -0.004), 0.050)

    # A continuous secondary surface avoids notches between every flight feather.
    spans = (0, 0.055, 0.12, 0.185, 0.22, 0.27, 0.32)
    leading = (0.052, 0.078, 0.084, 0.069, 0.048, 0.006, -0.036)
    trailing = (-0.122, -0.146, -0.154, -0.155, -0.148, -0.133, -0.114)
    fractions = (0, 0.14, 0.33, 0.39, 0.445, 0.50, 0.56, 0.79, 0.95, 1)
    heights = (0.002, 0.013, 0.012, 0.011, 0.010, 0.009, 0.008, 0.001, -0.003, -0.004)
    vertices, colors = [], []
    for row, span in enumerate(spans):
        tip_taper = max(0, min(1, (0.32 - span) / 0.10))
        for fraction, height in zip(fractions, heights):
            surface_height = -0.003 + (height + 0.003) * tip_taper
            vertices.append(point(leading[row] * (1 - fraction) + trailing[row] * fraction, span, surface_height))
            is_trailing_edge = fraction == 1
            is_flight = fraction >= 0.79 or span >= 0.27
            base = FLIGHT if is_flight else PALE
            strength = 1 if is_trailing_edge else 0
            colors.append(tuple(base[i] * (1 - strength) + DARK[i] * strength for i in range(3)) + (0,))
    columns = len(fractions)
    faces = [(row * columns + col, row * columns + col + 1,
              (row + 1) * columns + col + 1, (row + 1) * columns + col)
             for row in range(len(spans) - 1) for col in range(columns - 1)]
    mesh.sheet(vertices, faces, PALE, colors)
    # Matching the base grid keeps the two dark bars flush without broad color interpolation.
    for start, end in ((0.33, 0.39), (0.50, 0.56)):
        vertices = []
        for row in range(5):
            is_tip_row = row == 4
            span = 0.205 if is_tip_row else spans[row]
            mix = (span - spans[3]) / (spans[4] - spans[3]) if is_tip_row else 0
            lead = leading[3] * (1 - mix) + leading[4] * mix if is_tip_row else leading[row]
            trail = trailing[3] * (1 - mix) + trailing[4] * mix if is_tip_row else trailing[row]
            for fraction in (start, end):
                height = heights[fractions.index(fraction)] + 0.0003
                vertices.append(point(lead * (1 - fraction) + trail * fraction, span, height))
        mesh.sheet(vertices, [(i * 2, i * 2 + 1, i * 2 + 3, i * 2 + 2) for i in range(4)], DARK)
    return mesh


def make_tail(spread):
    mesh = Mesh("PigeonTailSpread" if spread else "PigeonTailFolded")
    joint = Vector(JOINTS["tail_joint"])
    is_folded = not spread
    if is_folded:
        rows = ((0, 0.021, 0.012, GRAY), (-0.055, 0.024, 0.015, GRAY),
                (-0.110, 0.030, 0.014, GRAY), (-0.132, 0.033, 0.012, GRAY),
                (-0.142, 0.034, 0.011, DARK), (-0.164, 0.036, 0.008, DARK))
        vertices, colors, faces = [], [], []
        for x, width, height, color in rows:
            center_y = x * 0.055
            for vertical, lateral in ((1, -1), (1, 1), (-1, 1), (-1, -1)):
                vertices.append(joint + Vector((x, center_y + height * vertical, width * lateral)))
                colors.append(color)
        for row in range(len(rows) - 1):
            for col in range(4):
                a, b = row * 4 + col, row * 4 + (col + 1) % 4
                faces.append((a, a + 4, b + 4, b))
        faces.extend(((0, 1, 2, 3), (23, 22, 21, 20)))
        mesh.add(vertices, faces, GRAY, colors=colors)
        return mesh

    # Twelve shallow scallops share their seams; separate tapered quads would make a sawtooth fan.
    vertices, colors = [joint], [GRAY]
    for radius, color in ((0.128, GRAY), (0.140, DARK)):
        for index in range(13):
            angle = -0.70 + index * 1.40 / 12
            vertices.append(joint + Vector((-radius * math.cos(angle), -radius * 0.055, radius * math.sin(angle))))
            colors.append(color)
    for index in range(25):
        angle = -0.70 + index * 1.40 / 24
        radius = 0.164 - (0.0008 if index % 2 == 0 else 0)
        vertices.append(joint + Vector((-radius * math.cos(angle), -radius * 0.055, radius * math.sin(angle))))
        colors.append(DARK)
    faces = []
    for i in range(12):
        faces.append((0, 1 + i, 2 + i))
        faces.append((1 + i, 14 + i, 15 + i, 2 + i))
        faces.extend(((14 + i, 27 + 2 * i, 28 + 2 * i),
                      (14 + i, 28 + 2 * i, 15 + i),
                      (15 + i, 28 + 2 * i, 29 + 2 * i)))
    mesh.sheet(vertices, faces, GRAY, colors)
    return mesh


def read_glb(path):
    data = path.read_bytes()
    magic, version, size = struct.unpack_from("<4sII", data)
    assert (magic, version, size) == (b"glTF", 2, len(data))
    json_size, kind = struct.unpack_from("<I4s", data, 12)
    assert kind == b"JSON"
    document = json.loads(data[20:20 + json_size])
    binary_start = 20 + json_size + 8
    return document, data[binary_start:]


def accessor_values(document, binary, index):
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    channels = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    codes = {5126: "f", 5125: "I", 5123: "H", 5121: "B"}
    code = codes[accessor["componentType"]]
    length = struct.calcsize("<" + code * channels)
    stride = view.get("byteStride", length)
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    values = [struct.unpack_from("<" + code * channels, binary, offset + i * stride) for i in range(accessor["count"])]
    is_normalized = accessor.get("normalized", False)
    if is_normalized:
        maximum = {5123: 65535, 5121: 255}[accessor["componentType"]]
        values = [tuple(v / maximum for v in value) for value in values]
    return values


def bounds(points):
    return {"min": [round(min(p[i] for p in points), 6) for i in range(3)],
            "max": [round(max(p[i] for p in points), 6) for i in range(3)]}


def validate_export(path, objects):
    document, binary = read_glb(path)
    assert not any(document.get(key) for key in ("animations", "cameras", "images", "textures"))
    assert not document.get("extensionsRequired")
    assert {node["name"] for node in document["nodes"]} == set(LIMITS)
    result = {}
    for node in document["nodes"]:
        name = node["name"]
        assert not any(key in node for key in ("translation", "rotation", "scale", "matrix", "children")), node
        primitives = document["meshes"][node["mesh"]]["primitives"]
        triangles, positions, alpha, materials = 0, [], [], []
        for primitive in primitives:
            assert primitive.get("mode", 4) == 4
            assert not primitive.get("extensions")
            attributes = primitive["attributes"]
            assert "COLOR_0" in attributes and "NORMAL" in attributes
            colors = accessor_values(document, binary, attributes["COLOR_0"])
            assert len(colors[0]) == 4, "The iridescence alpha mask must survive GLB export"
            alpha.extend(c[3] for c in colors)
            positions.extend(accessor_values(document, binary, attributes["POSITION"]))
            triangles += document["accessors"][primitive["indices"]]["count"] // 3
            material = document["materials"][primitive["material"]]
            assert material.get("alphaMode", "OPAQUE") == "OPAQUE"
            materials.append(material["name"])
            is_wing = name in ("PigeonWingL", "PigeonWingR")
            if is_wing:
                normals = accessor_values(document, binary, attributes["NORMAL"])
                assert min(normal[1] for normal in normals) > 0.5
        assert triangles <= LIMITS[name], (name, triangles)
        is_head = name == "PigeonHead"
        assert max(alpha) > 0.9 if is_head else max(alpha) == 0
        joint_name = PART_JOINTS.get(name)
        joint = JOINTS[joint_name] if joint_name else (0, 0, 0)
        source = next(obj for obj in objects if obj.name == name)
        result[name] = {
            "triangles": triangles, "triangle_budget": LIMITS[name],
            "vertices": len(positions), "source_vertices": len(source.data.vertices),
            "bbox_local": bounds(positions),
            "bbox_assembled": bounds([tuple(p[i] + joint[i] for i in range(3)) for p in positions]),
            "materials": sorted(set(materials)),
            "color_alpha_range": [round(min(alpha), 4), round(max(alpha), 4)],
            "assembly_translation": joint,
        }
    body = next(node for node in document["nodes"] if node["name"] == "PigeonBody")
    assert all(body["extras"][key] == value for key, value in JOINTS.items())
    assert path.stat().st_size <= 200_000
    return result


def flat_material(name, color, roughness=0.8):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    return material


def assemble(objects, position=(0, 0, 0), yaw=0, flying=False, flap=0, peck=0):
    active = {"PigeonBody", "PigeonHead"}
    active.update({"PigeonWingL", "PigeonWingR", "PigeonTailSpread"} if flying else
                  {"PigeonLegs", "PigeonWingsFolded", "PigeonTailFolded"})
    root = Matrix.Translation(game_to_blender(position)) @ Matrix.Rotation(math.radians(yaw), 4, "Z")
    copies = []
    for original in objects:
        is_active = original.name in active
        if not is_active:
            continue
        obj = bpy.data.objects.new("preview_" + original.name, original.data)
        bpy.context.collection.objects.link(obj)
        joint_name = PART_JOINTS.get(original.name)
        joint = JOINTS[joint_name] if joint_name else (0, 0, 0)
        matrix = root @ Matrix.Translation(game_to_blender(joint))
        is_wing = original.name in ("PigeonWingL", "PigeonWingR")
        is_head = original.name == "PigeonHead"
        if is_wing:
            side = 1 if original.name == "PigeonWingL" else -1
            matrix @= Matrix.Rotation(math.radians(-flap * side), 4, "X")
        if is_head:
            matrix @= Matrix.Rotation(math.radians(peck), 4, "Y")
        obj.matrix_world = matrix
        copies.append(obj)
    return copies


def setup_preview():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.cycles.seed = 41
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("PreviewSky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.43, 0.66, 0.84, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.5
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=200)
    ground = bpy.context.object
    ground.name = "PreviewDirt"
    ground.location.z = -0.001
    ground.location.y = -94
    ground.data.materials.append(flat_material("PreviewSand", (0.34, 0.235, 0.13)))
    bpy.ops.object.light_add(type="AREA", location=(0.8, -1.0, 2.8))
    light = bpy.context.object
    light.data.energy = 150
    light.data.shape = "DISK"
    light.data.size = 2.5
    light.rotation_euler = (Vector((0, 0, 0.15)) - light.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.light_add(type="SUN", location=(0, 0, 3))
    bpy.context.object.data.energy = 1.3
    bpy.context.object.data.angle = 0.25
    bpy.context.object.rotation_euler = (0.4, -0.6, -0.5)
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    scene.camera = camera
    return camera, ground


def render_preview(camera, directory, name, eye, target, scale, size=(800, 800)):
    scene = bpy.context.scene
    camera.location = game_to_blender(eye)
    direction = game_to_blender(target) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    camera.data.ortho_scale = scale
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.filepath = str(directory / name)
    bpy.ops.render.render(write_still=True)


def remove_objects(objects):
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)


def render_previews(objects, directory, standing_only=False):
    for obj in objects:
        obj.hide_render = True
    camera, ground = setup_preview()
    copies = assemble(objects)
    render_preview(camera, directory, "standing_side.png", (0.03, 0.255, 1.8), (-0.02, 0.18, 0), 0.66)
    render_preview(camera, directory, "standing_3q.png", (1.1, 0.73, 1.2), (-0.02, 0.18, 0), 0.66)
    remove_objects(copies)
    if standing_only:
        return
    for name, flap, eye in (("flying_top.png", 0, (0, 2.4, 0.001)),
                            ("flying_down.png", -20, (0.9, 1.15, 1.5)),
                            ("flying_up.png", 45, (0.9, 1.15, 1.5))):
        copies = assemble(objects, position=(0, 0.37, 0), flying=True, flap=flap)
        render_preview(camera, directory, name, eye, (0, 0.54, 0), 1.16)
        remove_objects(copies)
    copies = assemble(objects, flying=True)
    ghost = flat_material("PreviewJointGhost", (0.35, 0.42, 0.48))
    ghost.node_tree.nodes.get("Principled BSDF").inputs["Alpha"].default_value = 0.16
    bpy.context.scene.cycles.transparent_max_bounces = 16
    for obj in copies:
        obj.data = obj.data.copy()
        obj.data.materials.clear()
        obj.data.materials.append(ghost)
        for polygon in obj.data.polygons:
            polygon.material_index = 0
    red = flat_material("PreviewJointRed", (0.95, 0.008, 0.012), 0.35)
    for point in [(0, 0, 0), *JOINTS.values()]:
        bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=0.009, location=game_to_blender(point))
        marker = bpy.context.object
        marker.data.materials.append(red)
        copies.append(marker)
    render_preview(camera, directory, "joints.png", (0.95, 0.95, 1.25), (0, 0.18, 0), 1.14)
    remove_objects(copies)
    flock = []
    for i in range(9):
        row, col = divmod(i, 3)
        pos = ((col - 1) * 0.62 + 0.11 * math.sin(i * 2.1), 0, (row - 1) * 0.62)
        flock.extend(assemble(objects, position=pos, yaw=i * 73 + 13,
                              peck=(0, 24, 110, 12, 95, 18, 116, 0, 31)[i]))
    for i in range(3):
        flock.extend(assemble(objects, position=(-0.8 + i * 0.9, 0.48 + i * 0.27, -1.15),
                              yaw=15 + i * 55, flying=True, flap=(-20, 45, 12)[i]))
    bpy.ops.mesh.primitive_cube_add(size=1, location=game_to_blender((-2.0, 1.2, -0.3)))
    box = bpy.context.object
    box.dimensions = (0.70, 1.8, 2.4)
    box.data.materials.append(flat_material("PreviewHorseScale", (0.21, 0.115, 0.057)))
    flock.append(box)
    bpy.ops.object.text_add(location=game_to_blender((-2.0, 2.56, -0.3)))
    label = bpy.context.object
    label.data.body = "2.4 units"
    label.data.align_x = "CENTER"
    label.data.size = 0.16
    label.data.materials.append(flat_material("PreviewLabel", (0.035, 0.028, 0.022)))
    label.rotation_euler = (game_to_blender((4.7, 4.5, 6.0)) - label.location).to_track_quat("Z", "Y").to_euler()
    flock.append(label)
    render_preview(camera, directory, "flock.png", (4.7, 4.5, 6.0), (-0.65, 1.08, -0.25), 7.0, (1280, 720))
    remove_objects(flock)


def main():
    started = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "packages/web/public/models/pigeon.glb")
    parser.add_argument("--preview-dir", type=Path, default=PREVIEW_DIR)
    parser.add_argument("--skip-previews", action="store_true")
    parser.add_argument("--standing-previews-only", action="store_true")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.preview_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    materials = create_materials()
    meshes = [make_body(), make_head(), make_legs(), make_folded_wings(),
              make_wing(1), make_wing(-1), make_tail(False), make_tail(True)]
    objects = [mesh.finish(materials) for mesh in meshes]
    for key, value in JOINTS.items():
        objects[0][key] = value
    objects[0]["coordinate_system"] = "+X forward, +Y up, +Z left; all nodes at origin"
    objects[0]["color_alpha_semantics"] = "iridescence strength, not opacity"
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(args.output), export_format="GLB", use_selection=True,
        export_yup=True, export_extras=True, export_texcoords=False,
        export_normals=True, export_materials="EXPORT", export_attributes=False,
        export_vertex_color="NAME", export_vertex_color_name="COLOR_0",
        export_all_vertex_colors=False, export_animations=False,
        export_cameras=False, export_lights=False, export_draco_mesh_compression_enable=False,
    )
    nodes = validate_export(args.output, objects)
    stats = {"coordinate_system": "+X forward, +Y up, +Z left", "nodes": nodes,
             "joints": JOINTS, "total_triangles": sum(n["triangles"] for n in nodes.values()),
             "glb_bytes": args.output.stat().st_size,
             "glb_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
             "geometry_export_seconds": round(time.monotonic() - started, 3)}
    should_render = not args.skip_previews
    if should_render:
        render_previews(objects, args.preview_dir, standing_only=args.standing_previews_only)
    standing_names = ("PigeonBody", "PigeonHead", "PigeonLegs", "PigeonWingsFolded", "PigeonTailFolded")
    flight_names = ("PigeonBody", "PigeonHead", "PigeonWingL", "PigeonWingR", "PigeonTailSpread")
    stats["standing_triangles"] = sum(nodes[name]["triangles"] for name in standing_names)
    stats["flying_triangles"] = sum(nodes[name]["triangles"] for name in flight_names)
    stats["standing_length"] = round(nodes["PigeonHead"]["bbox_assembled"]["max"][0] - nodes["PigeonTailFolded"]["bbox_assembled"]["min"][0], 6)
    stats["standing_height"] = nodes["PigeonHead"]["bbox_assembled"]["max"][1]
    stats["wingspan"] = round(nodes["PigeonWingL"]["bbox_assembled"]["max"][2] - nodes["PigeonWingR"]["bbox_assembled"]["min"][2], 6)
    stats["previews_rendered"] = should_render
    stats["preview_scope"] = "standing" if args.standing_previews_only else "all"
    stats["generation_seconds"] = round(time.monotonic() - started, 3)
    stats["blender_version"] = bpy.app.version_string
    report = json.dumps(stats, indent=2)
    (args.preview_dir / "stats.json").write_text(report + "\n")
    print(report, flush=True)


if __name__ == "__main__":
    main()
