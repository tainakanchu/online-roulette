# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic starting-gate modules. Run with Blender's bundled Python.

Geometry arguments and reported bounds use game coordinates: X forward, Y up,
Z across stalls. Blender coordinates are (X, -Z, Y); glTF exports back to game
coordinates. Clone modules using a 1.7 Z pitch. Preserve door node translations;
front doors open around local Y: left +90 degrees, right -90 degrees.
Rear doors open in the opposite directions. No runtime animation is exported.
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
import bmesh
from mathutils import Vector


PITCH = 1.7
DEPTH = 4.6
FRONT_X = DEPTH / 2
REAR_X = -DEPTH / 2
# プレビュー画像と統計の出力先。環境変数 BLENDER_PREVIEW_DIR で変えられる（既定は OS の一時フォルダー）
OUT_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "gate"
MATERIAL_NAMES = ("GateGreen", "GateWhite", "GatePad", "GateRubber", "GateLamp", "GateSign")
SIGN_BOTTOM = 4.46
SIGN_TOP = 4.86


def native(p):
    return Vector((p[0], -p[2], p[1]))


def game(p):
    return (p[0], p[2], -p[1])


def linear(v):
    is_dark = v <= 0.04045
    if is_dark:
        return v / 12.92
    return ((v + 0.055) / 1.055) ** 2.4


def material(name, color, roughness, metallic=0.0, emission=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    rgb = tuple(linear(int(color[i:i + 2], 16) / 255) for i in (0, 2, 4))
    mat.diffuse_color = (*rgb, 1)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
    bsdf.inputs["Emission Strength"].default_value = emission
    return mat


class MeshBuilder:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.material_ids = []
        self.smooth = []

    def append(self, vertices, faces, mat, smooth=False):
        offset = len(self.vertices)
        self.vertices.extend(tuple(p) for p in vertices)
        self.faces.extend(tuple(offset + i for i in f) for f in faces)
        self.material_ids.extend([MATERIAL_NAMES.index(mat)] * len(faces))
        self.smooth.extend([smooth] * len(faces))

    def box(self, center, size, mat, bevel=0.0):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        for v in bm.verts:
            v.co = Vector(tuple(v.co[i] * size[i] for i in range(3)))
        has_bevel = bevel > 0
        if has_bevel:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect="EDGES")
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        self.append([v.co + Vector(center) for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces], mat)
        bm.free()

    def pipe(self, start, end, radius, mat, sides=10):
        a, b = Vector(start), Vector(end)
        axis = (b - a).normalized()
        ref = Vector((0, 1, 0))
        is_vertical = abs(axis.dot(ref)) > 0.95
        if is_vertical:
            ref = Vector((1, 0, 0))
        u = axis.cross(ref).normalized()
        v = axis.cross(u).normalized()
        vertices = [p + radius * (u * math.cos(i * math.tau / sides) + v * math.sin(i * math.tau / sides)) for p in (a, b) for i in range(sides)]
        faces = [(i, (i + 1) % sides, (i + 1) % sides + sides, i + sides) for i in range(sides)]
        self.append(vertices, faces, mat, smooth=True)
        self.append(vertices, [tuple(reversed(range(sides))), tuple(range(sides, 2 * sides))], mat)

    def tire(self, center):
        # A profiled closed ring retains the wheel's opening without a texture.
        cx, cy, cz = center
        profile = [(-0.16, 0.27), (-0.22, 0.34), (-0.22, 0.48), (-0.15, 0.56), (0.15, 0.56), (0.22, 0.48), (0.22, 0.34), (0.16, 0.27)]
        sides = 24
        vertices = [(cx + r * math.cos(i * math.tau / sides), cy + r * math.sin(i * math.tau / sides), cz + z) for z, r in profile for i in range(sides)]
        faces = []
        for j in range(len(profile)):
            for i in range(sides):
                faces.append((j * sides + i, j * sides + (i + 1) % sides, ((j + 1) % len(profile)) * sides + (i + 1) % sides, ((j + 1) % len(profile)) * sides + i))
        self.append(vertices, faces, "GateRubber", smooth=True)
        self.pipe((cx, cy, cz - 0.17), (cx, cy, cz + 0.17), 0.275, "GateWhite", 16)
        self.pipe((cx, cy, cz - 0.24), (cx, cy, cz + 0.24), 0.11, "GateGreen", 12)
        for side in (-1, 1):
            for i in range(6):
                angle = i * math.tau / 6
                x, y = cx + 0.18 * math.cos(angle), cy + 0.18 * math.sin(angle)
                self.pipe((x, y, cz + side * 0.17), (x, y, cz + side * 0.185), 0.025, "GateGreen", 6)

    def finish(self, name, materials, origin=(0, 0, 0)):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([native(Vector(p) - Vector(origin)) for p in self.vertices], [], self.faces)
        for mat in materials:
            mesh.materials.append(mat)
        for polygon, mat_id, smooth in zip(mesh.polygons, self.material_ids, self.smooth):
            polygon.material_index = mat_id
            polygon.use_smooth = smooth
        # Recalculate closed-component winding, including the profiled tire ring.
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bmesh.ops.triangulate(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = native(origin)
        obj["coordinate_system"] = "+X forward, +Y up, Z across stalls (glTF)"
        obj["bay_pitch"] = PITCH
        return obj


def partition(materials):
    m = MeshBuilder()
    for x in (REAR_X, FRONT_X):
        m.box((x, 1.8, 0), (0.12, 3.6, 0.10), "GateWhite", 0.014)
        m.box((x, 0.08, 0), (0.25, 0.10, 0.19), "GateGreen", 0.02)
        for y in (0.83, 2.18):
            m.pipe((x, y - 0.21, 0), (x, y + 0.21, 0), 0.024, "GateGreen")
            for dy in (-0.20, 0.20):
                m.pipe((x, y + dy - 0.025, 0), (x, y + dy + 0.025, 0), 0.062, "GateGreen")
    m.box((0, 1.8, 0), (0.12, 3.6, 0.10), "GateWhite", 0.014)
    m.box((0, 0.08, 0), (0.25, 0.10, 0.19), "GateGreen", 0.02)
    for y in (0.52, 1.84, 2.72, 3.48):
        m.pipe((REAR_X, y, 0), (FRONT_X, y, 0), 0.041, "GateWhite")
    for x in (-DEPTH / 4, DEPTH / 4):
        m.pipe((x, 0.52, 0), (x, 2.72, 0), 0.032, "GateWhite")
    for i in range(4):
        x = REAR_X + (i + 0.5) * DEPTH / 4
        m.box((x, 1.17, 0), (DEPTH / 4, 1.20, 0.16), "GatePad", 0.035)
    m.box((FRONT_X + 0.02, 3.21, 0), (0.24, 0.30, 0.23), "GateGreen", 0.025)
    m.pipe((FRONT_X + 0.14, 3.21, 0), (FRONT_X + 0.20, 3.21, 0), 0.090, "GateRubber", 12)
    m.pipe((FRONT_X + 0.20, 3.21, 0), (FRONT_X + 0.235, 3.21, 0), 0.071, "GateLamp", 12)
    m.box((FRONT_X + 0.15, 3.385, 0), (0.26, 0.035, 0.27), "GateWhite", 0.01)
    return m.finish("Partition", materials)


def door(materials, side, rear=False):
    m = MeshBuilder()
    hinge_x = REAR_X if rear else FRONT_X
    # Adjacent leaves would coincide at 90 degrees without this hinge offset.
    x = hinge_x + (-0.085 if rear else 0.085)
    hinge = side * PITCH / 2
    inside = -side
    z0, z1 = hinge + inside * 0.075, side * 0.035
    bottom, top = 0.48, 2.55
    for z in (z0, z1):
        m.pipe((x, bottom, z), (x, top, z), 0.037, "GateWhite")
    rails = (bottom, 1.52, 2.04, top) if rear else (bottom, 1.15, 1.50, 1.85, 2.20, top)
    for y in rails:
        m.pipe((x, y, z0), (x, y, z1), 0.032, "GateWhite")
    middle = (z0 + z1) / 2
    if rear:
        m.box((x, 1.0, middle), (0.052, 0.98, abs(z1 - z0) - 0.05), "GateWhite", 0.012)
    else:
        m.pipe((x, 1.15, middle), (x, top, middle), 0.023, "GateWhite", 8)
        m.box((x, 0.825, middle), (0.052, 0.61, abs(z1 - z0) - 0.05), "GateWhite", 0.012)
        m.box((x, 1.51, side * 0.031), (0.092, 2.14, 0.052), "GatePad", 0.012)
        m.box((x, 0.475, middle), (0.086, 0.080, abs(z1 - z0)), "GatePad", 0.012)
    for y in (0.83, 2.18):
        y += side * 0.09
        m.pipe((hinge_x, y, hinge), (x, y, z0), 0.028, "GateWhite")
        m.pipe((hinge_x, y - 0.07, hinge), (hinge_x, y + 0.07, hinge), 0.049, "GateWhite")
    m.box((x + (-0.05 if rear else 0.05), 1.42, z1), (0.05, 0.14, 0.045), "GateGreen", 0.01)
    name = ("RearDoor" if rear else "Door") + ("Left" if side < 0 else "Right")
    obj = m.finish(name, materials, (hinge_x, 0, hinge))
    obj["hinge_axis"] = "Y"
    obj["open_angle_degrees"] = side * (90 if rear else -90)
    return obj


def truss(materials):
    m = MeshBuilder()
    for x in (REAR_X, FRONT_X):
        for y in (3.62, 4.14):
            m.box((x, y, 0), (0.14, 0.12, PITCH), "GateGreen")
        for i in range(4):
            z0 = -0.825 + i * 1.65 / 4
            z1 = z0 + 1.65 / 4
            is_even = i % 2 == 0
            y0, y1 = (3.68, 4.08) if is_even else (4.08, 3.68)
            m.pipe((x, y0, z0), (x, y1, z1), 0.035, "GateGreen", 8)
        m.box((x, 3.88, 0), (0.09, 0.44, 0.075), "GateGreen")
        m.box((x, 3.62, -0.80), (0.25, 0.06, 0.10), "GateGreen")
    for z in (-0.80, 0.0, 0.80):
        m.box((0, 4.04, z), (DEPTH, 0.10, 0.07), "GateGreen")
    m.pipe((REAR_X + 0.02, 4.10, -0.80), (FRONT_X - 0.02, 4.10, 0.80), 0.026, "GateGreen", 8)
    # Open roof battens preserve visibility of the lattice and horses.
    for x in (-DEPTH / 4, 0, DEPTH / 4):
        m.box((x, 4.16, 0), (0.065, 0.08, PITCH), "GateGreen")
    return m.finish("TrussBay", materials)


def sign(materials):
    m = MeshBuilder()
    m.box((FRONT_X - 0.02, 4.57, 0), (0.10, 0.66, PITCH), "GateGreen")
    # Vertical end caps belong to EndFrame; per-bay caps would divide the sign.
    m.append([(FRONT_X + 0.035, SIGN_BOTTOM, -0.85), (FRONT_X + 0.035, SIGN_TOP, -0.85),
              (FRONT_X + 0.035, SIGN_TOP, 0.85), (FRONT_X + 0.035, SIGN_BOTTOM, 0.85)],
             [(0, 1, 2, 3)], "GateSign")
    for y in (4.26, 4.44, 4.88):
        m.box((FRONT_X, y, 0), (0.15, 0.04, PITCH), "GateGreen")
    m.box((FRONT_X - 0.01, 4.35, 0), (0.13, 0.14, PITCH), "GateGreen")
    for z in (-0.55, 0.55):
        m.box((FRONT_X - 0.07, 4.25, z), (0.065, 0.28, 0.055), "GateGreen")
    obj = m.finish("SignPanel", materials)
    uv = obj.data.uv_layers.new(name="SignUV")
    for polygon in obj.data.polygons:
        is_sign = polygon.material_index == MATERIAL_NAMES.index("GateSign")
        if is_sign:
            for loop_index in polygon.loop_indices:
                point = game(obj.data.vertices[obj.data.loops[loop_index].vertex_index].co)
                uv.data[loop_index].uv = sign_uv(point)
    return obj


def sign_uv(point):
    return ((point[2] + PITCH / 2) / PITCH,
            (point[1] - SIGN_BOTTOM) / (SIGN_TOP - SIGN_BOTTOM))


def end_frame(materials, side):
    m = MeshBuilder()
    z = side * 0.24
    for x in (REAR_X, FRONT_X):
        m.box((x, 2.13, z), (0.22, 4.02, 0.22), "GateGreen", 0.022)
        m.box((x, 3.90, side * 0.16), (0.30, 0.62, 0.48), "GateGreen", 0.016)
        m.pipe((x, 0.56, side * 0.10), (x, 0.56, side * 0.98), 0.105, "GateGreen", 12)
        m.tire((x, 0.56, side * 0.77))
        m.box((x, 0.98, side * 0.26), (0.68, 0.10, 0.23), "GateGreen", 0.015)
        m.pipe((x, 1.15, z), (x * 0.5, 1.85, z), 0.062, "GateGreen")
    for y in (0.37, 1.18, 3.62, 4.12):
        m.box((0, y, z), (DEPTH + 0.22, 0.16, 0.18), "GateGreen", 0.01)
    m.pipe((REAR_X + 0.10, 1.25, z), (FRONT_X - 0.10, 3.55, z), 0.057, "GateGreen")
    m.box((FRONT_X - 0.02, 4.56, side * 0.025), (0.15, 0.68, 0.05), "GateGreen")
    # A compact tow eye stays outside every stall and does not cross the exit.
    m.pipe((REAR_X + 0.10, 0.44, z), (REAR_X - 0.65, 0.44, z), 0.075, "GateGreen")
    for dz in (-0.10, 0.10):
        m.pipe((REAR_X - 0.60, 0.44, z + dz), (REAR_X - 0.88, 0.44, z + dz), 0.04, "GateGreen", 8)
    m.pipe((REAR_X - 0.88, 0.44, z - 0.10), (REAR_X - 0.88, 0.44, z + 0.10), 0.04, "GateGreen", 8)
    # Rear outboard platforms leave both the stall entrance and tire clear.
    for distance in (0.31, 1.17):
        pz = side * distance
        m.box((REAR_X - 0.86, 0.39, pz), (1.64, 0.12, 0.07), "GateGreen", 0.012)
    for x in (REAR_X - 0.65, REAR_X - 1.65):
        m.box((x, 0.42, side * 0.74), (0.07, 0.10, 0.93), "GateGreen", 0.01)
        m.pipe((x, 0.45, side * 1.17), (x, 1.53, side * 1.17), 0.035, "GateGreen")
    for i in range(12):
        m.box((REAR_X - 1.62 + i * 0.085, 0.46, side * 0.74), (0.029, 0.045, 0.86), "GateGreen")
    for i in range(6):
        m.box((REAR_X - 1.15, 0.448, side * (0.35 + i * 0.155)), (0.98, 0.026, 0.018), "GateGreen")
    for y in (1.0, 1.53):
        m.pipe((REAR_X - 1.65, y, side * 1.17), (REAR_X - 0.65, y, side * 1.17), 0.035, "GateGreen")
        m.pipe((REAR_X - 0.65, y, side * 1.17), (REAR_X - 0.65, y, side * 0.31), 0.035, "GateGreen")
    m.pipe((REAR_X - 0.65, 0.45, side * 0.31), (REAR_X - 0.65, 1.53, side * 0.31), 0.035, "GateGreen")
    m.box((REAR_X - 1.74, 0.24, side * 0.74), (0.24, 0.07, 0.65), "GateGreen", 0.012)
    for distance in (0.48, 1.0):
        m.box((REAR_X - 1.66, 0.335, side * distance), (0.055, 0.20, 0.055), "GateGreen", 0.008)
    return m.finish("EndFrameLeft" if side < 0 else "EndFrameRight", materials)


def read_glb(path):
    raw = path.read_bytes()
    json_length = struct.unpack_from("<I", raw, 12)[0]
    document = json.loads(raw[20:20 + json_length])
    return document, raw[28 + json_length:]


def read_accessor(document, binary, index):
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[accessor["type"]]
    code = {5123: "H", 5125: "I", 5126: "f"}[accessor["componentType"]]
    fmt = "<" + code * width
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride", struct.calcsize(fmt))
    return [struct.unpack_from(fmt, binary, offset + i * stride) for i in range(accessor["count"])]


def write_sign_uv(path):
    # Blender UV layers apply to every material in a mesh and export flips V.
    # Add the attribute to just the white primitive to keep the requested V-up.
    document, binary = read_glb(path)
    node = next(n for n in document["nodes"] if n["name"] == "SignPanel")
    primitives = document["meshes"][node["mesh"]]["primitives"]
    primitive = next(p for p in primitives if document["materials"][p["material"]]["name"] == "GateSign")
    positions = read_accessor(document, binary, primitive["attributes"]["POSITION"])
    uvs = [tuple(round(v, 6) for v in sign_uv(point)) for point in positions]
    uv_bytes = b"".join(struct.pack("<2f", *uv) for uv in uvs)
    view_index = len(document["bufferViews"])
    document["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": len(uv_bytes), "target": 34962})
    primitive["attributes"]["TEXCOORD_0"] = len(document["accessors"])
    document["accessors"].append({"bufferView": view_index, "componentType": 5126, "count": len(uvs), "type": "VEC2", "min": [0, 0], "max": [1, 1]})
    binary += uv_bytes
    document["buffers"][0]["byteLength"] = len(binary)
    encoded = json.dumps(document, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    header = struct.pack("<4sII", b"glTF", 2, 28 + len(encoded) + len(binary))
    path.write_bytes(header + struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
                     + struct.pack("<II", len(binary), 0x004E4942) + binary)


def bounds(points):
    points = list(points)
    return {"min": [round(min(p[i] for p in points), 5) for i in range(3)], "max": [round(max(p[i] for p in points), 5) for i in range(3)]}


def inspect_glb(path, modules):
    raw = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", raw)
    assert magic == b"glTF" and version == 2 and length == len(raw)
    json_length, json_type = struct.unpack_from("<II", raw, 12)
    assert json_type == 0x4E4F534A
    gltf = json.loads(raw[20:20 + json_length])
    assert len(gltf["nodes"]) == len(modules) == 9
    assert len(gltf["meshes"]) == 9
    assert {n["name"] for n in gltf["nodes"]} == {m.name for m in modules}
    assert {m["name"] for m in gltf["materials"]} == set(MATERIAL_NAMES)
    for key in ("animations", "cameras", "skins", "images", "textures"):
        assert not gltf.get(key), key
    assert "KHR_draco_mesh_compression" not in gltf.get("extensionsUsed", [])
    assert "EXT_meshopt_compression" not in gltf.get("extensionsUsed", [])
    assert "KHR_meshopt_compression" not in gltf.get("extensionsUsed", [])
    binary = raw[28 + json_length:]
    result = {}
    for node in gltf["nodes"]:
        assert "mesh" in node and not node.get("children")
        assert "rotation" not in node and "scale" not in node and "matrix" not in node
        primitives = gltf["meshes"][node["mesh"]]["primitives"]
        uv_materials = []
        for primitive in primitives:
            mat_name = gltf["materials"][primitive["material"]]["name"]
            expects_uv = node["name"] == "SignPanel" and mat_name == "GateSign"
            has_uv = "TEXCOORD_0" in primitive["attributes"]
            assert has_uv == expects_uv
            if expects_uv:
                positions = read_accessor(gltf, binary, primitive["attributes"]["POSITION"])
                uvs = read_accessor(gltf, binary, primitive["attributes"]["TEXCOORD_0"])
                normals = read_accessor(gltf, binary, primitive["attributes"]["NORMAL"])
                assert all(normal[0] > 0.99 for normal in normals)
                assert all(abs(value - expected) < 1e-5 for point, uv in zip(positions, uvs)
                           for value, expected in zip(uv, sign_uv(point)))
                assert bounds([(u, v, 0) for u, v in uvs]) == {"min": [0, 0, 0], "max": [1, 1, 0]}
                uv_materials.append(mat_name)
        triangles = sum(gltf["accessors"][p["indices"]]["count"] // 3 for p in primitives)
        vertices = sum(gltf["accessors"][p["attributes"]["POSITION"]]["count"] for p in primitives)
        ranges = [gltf["accessors"][p["attributes"]["POSITION"]] for p in primitives]
        local_bounds = bounds([a[k] for a in ranges for k in ("min", "max")])
        translation = node.get("translation", [0, 0, 0])
        source = next(obj for obj in modules if obj.name == node["name"])
        assert all(abs(a - b) < 1e-6 for a, b in zip(translation, game(source.location)))
        assert triangles == len(source.data.polygons)
        result[node["name"]] = {"triangles": triangles, "vertices": vertices, "mesh_vertices": len(bpy.data.objects[node["name"]].data.vertices), "origin": translation, "bbox_local": local_bounds, "bbox_closed_placement": {k: [round(v + t, 5) for v, t in zip(values, translation)] for k, values in local_bounds.items()}}
        result[node["name"]]["uv_materials"] = uv_materials
    return result


def total_triangles(nodes, stalls):
    repeated = ("DoorLeft", "DoorRight", "RearDoorLeft", "RearDoorRight", "TrussBay", "SignPanel")
    return (stalls + 1) * nodes["Partition"]["triangles"] + stalls * sum(nodes[n]["triangles"] for n in repeated) + sum(nodes[n]["triangles"] for n in ("EndFrameLeft", "EndFrameRight"))


def assemble(modules, stalls):
    source = {obj.name: obj for obj in modules}
    assembly = []

    def copy(name, z):
        obj = source[name].copy()
        obj.data = source[name].data
        obj.name = f"Preview_{name}_{len(assembly):03d}"
        bpy.context.collection.objects.link(obj)
        obj.hide_render = False
        obj.location += native((0, 0, z))
        assembly.append(obj)
        return obj

    for i in range(stalls + 1):
        copy("Partition", (i - stalls / 2) * PITCH)
    for i in range(stalls):
        z = (i - (stalls - 1) / 2) * PITCH
        for name in ("DoorLeft", "DoorRight", "RearDoorLeft", "RearDoorRight", "TrussBay", "SignPanel"):
            copy(name, z)
    copy("EndFrameLeft", -stalls * PITCH / 2)
    copy("EndFrameRight", stalls * PITCH / 2)
    for obj in modules:
        obj.hide_render = True
        obj.hide_set(True)
    return assembly


def render_previews(modules, out_dir, samples):
    assembly = assemble(modules, 8)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = True
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("PreviewSky")
    scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    light_path = nt.nodes.new("ShaderNodeLightPath")
    sky = nt.nodes.new("ShaderNodeBackground")
    sky.inputs["Color"].default_value = (0.38, 0.65, 0.85, 1)
    ambient = nt.nodes.new("ShaderNodeBackground")
    ambient.inputs["Color"].default_value = (0.72, 0.82, 1, 1)
    ambient.inputs["Strength"].default_value = 0.55
    mix = nt.nodes.new("ShaderNodeMixShader")
    output = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(light_path.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(ambient.outputs[0], mix.inputs[1])
    nt.links.new(sky.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], output.inputs[0])
    grass = material("PreviewGrass", "698348", 0.95)
    bpy.ops.mesh.primitive_plane_add(size=20000, location=(0, 0, -0.015))
    bpy.context.object.name = "PreviewGround"
    bpy.context.object.data.materials.append(grass)
    sun = bpy.data.lights.new("PreviewSun", "SUN")
    sun.energy = 2.0
    sun.angle = math.radians(12)
    sun_obj = bpy.data.objects.new("PreviewSun", sun)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = native((-6, -10, 4)).to_track_quat("-Z", "Y").to_euler()
    camera = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    camera.data.type = "PERSP"
    camera.data.sensor_fit = "HORIZONTAL"
    camera.data.clip_end = 200000

    def render(name, position, target, scale, width=640):
        camera.location = native(position)
        camera.rotation_euler = (native(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.lens = camera.data.sensor_width * (native(target) - camera.location).length / scale
        scene.render.resolution_x = width
        scene.render.resolution_y = 640
        scene.render.filepath = str(out_dir / name)
        bpy.ops.render.render(write_still=True)

    render("front.png", (30, 4.5, 0), (0, 2.35, 0), 17.4, 1280)
    render("three_quarter.png", (20, 9, 17), (-0.4, 2.1, 0), 20.5)
    render("stall_closeup.png", (10.8, 3.6, 3.2), (1.8, 1.9, 0.85), 4.6)
    for obj in assembly:
        is_front_door = obj.name.startswith(("Preview_DoorLeft_", "Preview_DoorRight_"))
        if is_front_door:
            obj.rotation_euler.z = math.radians(obj["open_angle_degrees"])
    render("doors_open.png", (20, 8, 16), (-0.4, 2.1, 0), 21.0)
    assembly_bounds = bounds(game(obj.matrix_world @ v.co) for obj in assembly for v in obj.data.vertices)
    for obj in assembly:
        obj.hide_render = True
    render_horse_fit(modules, camera, render)
    sign_obj = next(obj for obj in modules if obj.name == "SignPanel")
    sign_obj.hide_render = False
    sign_mat = bpy.data.materials["GateSign"]
    nodes = sign_mat.node_tree.nodes
    links = sign_mat.node_tree.links
    uv_node = nodes.new("ShaderNodeUVMap")
    uv_node.uv_map = "SignUV"
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "MULTIPLY"
    scale.inputs[1].default_value = (8, 2, 1)
    checker = nodes.new("ShaderNodeTexChecker")
    checker.inputs["Scale"].default_value = 1
    checker.inputs["Color1"].default_value = (0.018, 0.028, 0.04, 1)
    checker.inputs["Color2"].default_value = (0.9, 0.62, 0.16, 1)
    links.new(uv_node.outputs["UV"], scale.inputs[0])
    links.new(scale.outputs["Vector"], checker.inputs["Vector"])
    links.new(checker.outputs["Color"], nodes.get("Principled BSDF").inputs["Base Color"])
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 2.1
    for label, y, z in (("u=0 / -Z", 4.95, -0.85), ("u=1 / +Z", 4.95, 0.85),
                        ("v=1 / top", 4.95, 0), ("v=0 / bottom", 4.15, 0)):
        text_data = bpy.data.curves.new("PreviewUVLabel", "FONT")
        text_data.body = label
        text_data.align_x = "CENTER"
        text_data.size = 0.055
        text_obj = bpy.data.objects.new("PreviewUVLabel", text_data)
        bpy.context.collection.objects.link(text_obj)
        text_obj.location = native((FRONT_X + 0.08, y, z))
        text_obj.rotation_euler = native((1, 0, 0)).to_track_quat("Z", "Y").to_euler()
        text_data.materials.append(bpy.data.materials["GateRubber"])
    render("sign_uv_check.png", (8, 4.56, 0), (FRONT_X - 0.02, 4.56, 0), 2.1)
    return assembly_bounds


def render_horse_fit(modules, camera, render):
    stall = assemble(modules, 1)
    for obj in stall:
        is_near_partition = obj.name.startswith("Preview_Partition") and game(obj.location)[2] < 0
        is_carriage = obj.name.startswith("Preview_EndFrame")
        if is_near_partition or is_carriage:
            obj.hide_render = True
    proxy_mat = material("PreviewHorseEnvelope", "ed2323", 0.7)
    nodes = proxy_mat.node_tree.nodes
    links = proxy_mat.node_tree.links
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    mix.inputs[0].default_value = 0.30
    links.new(transparent.outputs[0], mix.inputs[1])
    links.new(nodes.get("Principled BSDF").outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], nodes.get("Material Output").inputs["Surface"])
    bpy.ops.mesh.primitive_cube_add(size=1, location=native((0, 1.45, 0)))
    proxy = bpy.context.object
    proxy.name = "PreviewHorseEnvelope"
    proxy.scale = (3.9, 0.86, 2.9)
    proxy.data.materials.append(proxy_mat)
    detail_mat = material("PreviewFitDimensions", "9d1515", 0.7, emission=0.25)
    detail_materials = [detail_mat] * len(MATERIAL_NAMES)
    m = MeshBuilder()
    # Visible outlines keep the semitransparent envelope measurable over the pads.
    for x in (-1.95, 1.95):
        m.pipe((x, 0, -0.43), (x, 2.9, -0.43), 0.012, "GateGreen", 8)
    for y in (0, 2.9):
        m.pipe((-1.95, y, -0.43), (1.95, y, -0.43), 0.012, "GateGreen", 8)
    for boundary, tip in ((REAR_X, -1.95), (FRONT_X, 1.95)):
        m.pipe((boundary, 3.06, -0.5), (tip, 3.06, -0.5), 0.009, "GateGreen", 8)
        for x in (boundary, tip):
            m.pipe((x, 2.99, -0.5), (x, 3.13, -0.5), 0.009, "GateGreen", 8)
    lines = m.finish("PreviewHorseFitDimensions", detail_materials)
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 6.2
    orientation = native((0, 0, 1)).to_track_quat("-Z", "Y")
    labels = []
    for label, x, y, size in (
        ("HORSE + RIDER: 3.90 x 0.86 x 2.90", 0, -0.24, 0.15),
        ("-Z SIDE / near partition & end carriages hidden", 0, 5.13, 0.105),
        ("0.35", -2.125, 3.23, 0.12), ("0.35", 2.125, 3.23, 0.12),
        ("TAIL -1.95", -1.50, 0.15, 0.105), ("NOSE +1.95", 1.50, 0.15, 0.105),
        ("REAR -2.30", REAR_X, -0.08, 0.10), ("FRONT +2.30", FRONT_X, -0.08, 0.10),
    ):
        curve = bpy.data.curves.new("PreviewFitLabel", "FONT")
        curve.body = label
        curve.align_x = "CENTER"
        curve.size = size
        curve.materials.append(detail_mat)
        obj = bpy.data.objects.new("PreviewFitLabel", curve)
        bpy.context.collection.objects.link(obj)
        obj.location = native((x, y, -1.1))
        obj.rotation_euler = orientation.to_euler()
        labels.append(obj)
    render("stall_with_horse.png", (0, 2.4, -12), (0, 2.4, 0), 6.2)
    for obj in [*stall, proxy, lines, *labels]:
        obj.hide_render = True


def main():
    started = time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "public/models/starting-gate.glb")
    parser.add_argument("--preview-dir", type=Path, default=OUT_DIR)
    parser.add_argument("--samples", type=int, default=32)
    parser.add_argument("--skip-previews", action="store_true")
    has_separator = "--" in sys.argv
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if has_separator else [])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.preview_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    materials = [material("GateGreen", "1f6b2e", 0.65, 0.16), material("GateWhite", "eeeee5", 0.78, 0.04), material("GatePad", "252b2b", 0.92), material("GateRubber", "101415", 0.96), material("GateLamp", "f51e19", 0.32, emission=2.0), material("GateSign", "f8f6e9", 0.72)]
    modules = [partition(materials), door(materials, -1), door(materials, 1), door(materials, -1, True), door(materials, 1, True), truss(materials), sign(materials), end_frame(materials, -1), end_frame(materials, 1)]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in modules:
        obj.select_set(True)
        assert len(obj.modifiers) == 0
    bpy.ops.export_scene.gltf(filepath=str(args.output), export_format="GLB", use_selection=True, export_yup=True, export_animations=False, export_cameras=False, export_lights=False, export_texcoords=False, export_normals=True, export_materials="EXPORT", export_extras=True, export_draco_mesh_compression_enable=False)
    write_sign_uv(args.output)
    nodes = inspect_glb(args.output, modules)
    triangles_18 = total_triangles(nodes, 18)
    size = args.output.stat().st_size
    assert triangles_18 <= 150_000, triangles_18
    assert size <= 1_500_000, size
    stats = {"blender_version": bpy.app.version_string, "coordinate_system": "+X forward, +Y up, Z across stalls", "bay_pitch": PITCH, "nominal_depth": DEPTH, "clear_width_between_pads": 1.54, "clear_width_between_posts": 1.60, "note": "1.7 is the requested TrussBay/SignPanel repeat pitch; structural thickness reduces actual clear width. Bounds and origins use exported glTF coordinates. vertices counts include material/normal splits.", "nodes": nodes, "triangles_8_stalls": total_triangles(nodes, 8), "triangles_18_stalls": triangles_18, "glb_bytes": size, "glb_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(), "glb_path": str(args.output.resolve()), "preview_renderer": "Cycles CPU", "preview_samples": args.samples, "previews_rendered": not args.skip_previews, "door_open_y_degrees": {obj.name: obj["open_angle_degrees"] for obj in modules if "hinge_axis" in obj}, "validation": {"nine_mesh_nodes": True, "six_materials": True, "no_textures_cameras_lights_animations_skins": True, "uncompressed": True, "no_modifiers": True, "within_budgets": True}}
    stats["sign_uv"] = {"attribute": "TEXCOORD_0", "node": "SignPanel", "material": "GateSign", "u": "0 at -Z, 1 at +Z", "v": "0 at bottom, 1 at top", "white_face_y": [SIGN_BOTTOM, SIGN_TOP], "white_face_width": PITCH, "checker": "8 columns x 2 rows, procedural preview only"}
    stats["validation"]["uv_only_on_sign_white_face"] = True
    stats["validation"]["uv_range_and_direction_from_glb_binary"] = True
    front_inner = min(nodes[name]["bbox_closed_placement"]["min"][0] for name in ("DoorLeft", "DoorRight"))
    rear_inner = max(nodes[name]["bbox_closed_placement"]["max"][0] for name in ("RearDoorLeft", "RearDoorRight"))
    assert front_inner > 1.95 and rear_inner < -1.95
    stats["horse_fit"] = {
        "envelope_bbox": {"min": [-1.95, 0, -0.43], "max": [1.95, 2.9, 0.43]},
        "front_hinge_x": FRONT_X, "rear_hinge_x": REAR_X,
        "clearance_to_hinge_planes_each_end": round(FRONT_X - 1.95, 5),
        "conservative_front_door_clearance": round(front_inner - 1.95, 5),
        "conservative_rear_door_clearance": round(-1.95 - rear_inner, 5),
        "fits_between_closed_doors": True,
        "preview": "Orthographic from -Z; near partition and end carriages hidden only for the cutaway preview",
    }
    do_render = not args.skip_previews
    if do_render:
        stats["assembly_8_open_bbox"] = render_previews(modules, args.preview_dir, args.samples)
    stats["generation_seconds"] = round(time.perf_counter() - started, 3)
    encoded = json.dumps(stats, ensure_ascii=False, indent=2)
    (args.preview_dir / "stats.json").write_text(encoded + "\n", encoding="utf-8")
    print(encoded, flush=True)


if __name__ == "__main__":
    main()
