# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic metre-scale news studio, authored in game coordinates (Y up, Z front).

Blender -b --factory-startup -noaudio --python news_studio.py -- [--skip-previews]
Export precedes preview shading: procedural wood, city and screen graphics are
preview-only. No images, lights, cameras or modifiers enter the GLB.
"""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import random
import struct
import sys
import tempfile
import time

import bmesh
import bpy
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[4]
PREVIEW_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "news-studio"
TAU = math.tau
RNG = random.Random(73017)
MESHES = {}
SCREEN_SIZES = {}


def game_to_blender(p):
    return Vector((p[0], -p[2], p[1]))


def bounds(points):
    return {"min": [round(min(p[i] for p in points), 6) for i in range(3)],
            "max": [round(max(p[i] for p in points), 6) for i in range(3)]}


class Frame:
    def __init__(self, center=(0, 0, 0), yaw=0, normal=None):
        self.center = Vector(center)
        has_normal = normal is not None
        if has_normal:
            z = Vector(normal).normalized()
            reference = Vector((0, 1, 0))
            is_vertical = abs(z.dot(reference)) > 0.98
            if is_vertical:
                reference = Vector((0, 0, -1))
            x = reference.cross(z).normalized()
            y = z.cross(x).normalized()
            self.rotation = Matrix((x, y, z)).transposed()
            return
        self.rotation = Matrix.Rotation(yaw, 3, "Y")

    def point(self, p):
        return self.center + self.rotation @ Vector(p)


class Mesh:
    def __init__(self, name, origin=(0, 0, 0)):
        self.name = name
        self.origin = Vector(origin)
        self.vertices, self.faces, self.materials, self.smooth, self.uvs = [], [], [], [], []
        self.extras = {}

    def add(self, vertices, faces, material, frame=None, smooth=False, uvs=None):
        offset = len(self.vertices)
        self.vertices.extend(frame.point(p) if frame else Vector(p) for p in vertices)
        self.faces.extend(tuple(offset + i for i in f) for f in faces)
        self.materials.extend([material] * len(faces))
        self.smooth.extend(smooth if isinstance(smooth, list) else [smooth] * len(faces))
        self.uvs.extend(uvs if uvs else [None] * len(faces))

    def box(self, center, size, material, bevel=0, frame=None, segments=3):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        for v in bm.verts:
            v.co = Vector(tuple(v.co[i] * size[i] for i in range(3)))
        has_bevel = bevel > 0
        if has_bevel:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=segments, affect="EDGES")
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        bm.normal_update()
        vertices = [v.co + Vector(center) for v in bm.verts]
        faces = [[v.index for v in f.verts] for f in bm.faces]
        smoothing = [max(abs(x) for x in f.normal) < 0.999 for f in bm.faces]
        self.add(vertices, faces, material, frame, smoothing)
        bm.free()

    def pipe(self, start, end, radius, material, sides=16, end_radius=None, frame=None):
        a, b = Vector(start), Vector(end)
        axis = (b - a).normalized()
        reference = Vector((0, 1, 0))
        is_vertical = abs(axis.dot(reference)) > 0.95
        if is_vertical:
            reference = Vector((1, 0, 0))
        u = axis.cross(reference).normalized()
        v = axis.cross(u)
        r2 = radius if end_radius is None else end_radius
        vertices = [p + r * (u * math.cos(i * TAU / sides) + v * math.sin(i * TAU / sides))
                    for p, r in ((a, radius), (b, r2)) for i in range(sides)]
        faces = [(i, (i + 1) % sides, (i + 1) % sides + sides, i + sides) for i in range(sides)]
        faces.extend([tuple(reversed(range(sides))), tuple(range(sides, sides * 2))])
        self.add(vertices, faces, material, frame, [True] * sides + [False, False])

    def sphere(self, center, radii, material, segments=20, rings=12, irregular=False, frame=None):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1)
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        # UV-sphere BMesh allocation order varies across processes, including normal accumulation order.
        ordered = sorted(bm.verts, key=lambda vertex: tuple(vertex.co))
        indices = {vertex: i for i, vertex in enumerate(ordered)}
        vertices = []
        for v in ordered:
            p = v.co
            wave = 1 + 0.048 * math.sin(p.x * 19 + p.y * 7) * math.cos(p.z * 17) if irregular else 1
            vertices.append(Vector(center) + Vector(tuple(p[i] * radii[i] * wave for i in range(3))))
        faces = []
        for face in bm.faces:
            face_indices = [indices[v] for v in face.verts]
            first = face_indices.index(min(face_indices))
            faces.append(tuple(face_indices[first:] + face_indices[:first]))
        self.add(vertices, sorted(faces), material, frame, True)
        bm.free()

    def ring(self, radius, width, low, high, material, segments=192, start=0, end=TAU):
        vertices = []
        for i in range(segments + 1):
            a = start + (end - start) * i / segments
            for r, y in ((radius - width / 2, low), (radius + width / 2, low),
                         (radius + width / 2, high), (radius - width / 2, high)):
                vertices.append((r * math.sin(a), y, -r * math.cos(a)))
        faces, smooth = [], []
        for i in range(segments):
            for j in range(4):
                faces.append((4 * i + j, 4 * i + (j + 1) % 4, 4 * (i + 1) + (j + 1) % 4, 4 * (i + 1) + j))
                smooth.append(j in (1, 3))
        faces.extend([(3, 2, 1, 0), tuple(4 * segments + i for i in range(4))])
        self.add(vertices, faces, material, smooth=smooth)

    def finish(self, materials):
        data = bpy.data.meshes.new(self.name)
        data.from_pydata([game_to_blender(v - self.origin) for v in self.vertices], [], self.faces)
        names = list(dict.fromkeys(self.materials))
        for name in names:
            data.materials.append(materials[name])
        for f, material, smooth in zip(data.polygons, self.materials, self.smooth):
            f.material_index = names.index(material)
            f.use_smooth = smooth
        has_uv = any(uv is not None for uv in self.uvs)
        if has_uv:
            uv_layer = data.uv_layers.new(name="UVMap")
            for polygon, values in zip(data.polygons, self.uvs):
                for i, loop in enumerate(polygon.loop_indices):
                    # The exporter flips V; compensate to preserve the requested GLB bottom-left UV.
                    uv_layer.data[loop].uv = (values[i][0], 1 - values[i][1]) if values else (0, 0)
        data.update()
        obj = bpy.data.objects.new(self.name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = game_to_blender(self.origin)
        for key, value in self.extras.items():
            obj[key] = value
        return obj


def group(material):
    name = "Studio_" + material
    is_new = name not in MESHES
    if is_new:
        MESHES[name] = Mesh(name)
    return MESHES[name]


def node(name, origin):
    mesh = Mesh(name, origin)
    MESHES[name] = mesh
    return mesh


def box(center, size, material, bevel=0, frame=None):
    group(material).box(center, size, material, bevel, frame)


def pipe(start, end, radius, material, sides=16, end_radius=None, frame=None):
    group(material).pipe(start, end, radius, material, sides, end_radius, frame)


def screen(name, center, width, height, frame=None, material="Screen"):
    f = frame or Frame(center)
    mesh = node(name, f.point((0, 0, 0)))
    mesh.add([(-width / 2, -height / 2, 0), (width / 2, -height / 2, 0),
              (width / 2, height / 2, 0), (-width / 2, height / 2, 0)], [(0, 1, 2, 3)], material,
             f, uvs=[[(0, 0), (1, 0), (1, 1), (0, 1)]])
    mesh.extras["screen_size"] = [width, height]
    SCREEN_SIZES[name] = (width, height)
    return mesh


def border(frame, width, height, trim, depth, material, z=-0.04, bevel=0.01):
    for x in (-width / 2 - trim / 2, width / 2 + trim / 2):
        box((x, 0, z), (trim, height + 2 * trim, depth), material, bevel, frame)
    for y in (-height / 2 - trim / 2, height / 2 + trim / 2):
        box((0, y, z), (width, trim, depth), material, bevel, frame)


def curved_desk_band(low, high, depth, material, bevel=0):
    n = 96
    front = [(x, 0.32 - 0.36 * (x / 2.1) ** 2) for x in (-2.1 + 4.2 * i / n for i in range(n + 1))]
    back = [(x, z - depth) for x, z in reversed(front)]
    outline = front + back
    vertices = [(x, y, z) for y in (low, high) for x, z in outline]
    count = len(outline)
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces.extend((i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count))
    mesh = group(material)
    has_bevel = bevel > 0
    if has_bevel:
        bm = bmesh.new()
        vs = [bm.verts.new(v) for v in vertices]
        for face in faces:
            bm.faces.new([vs[i] for i in face])
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        # Only perimeter edges need a fillet; beveling subdivision edges scars the arc.
        bm.normal_update()
        edges = [e for e in bm.edges if e.calc_face_angle(0) > 0.3]
        bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=3, affect="EDGES")
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        bm.normal_update()
        mesh.add([v.co for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces], material,
                 smooth=[abs(f.normal.y) < 0.999 for f in bm.faces])
        bm.free()
        return
    # The desk outline runs clockwise when seen from above.
    bm = bmesh.new()
    vs = [bm.verts.new(v) for v in vertices]
    for face in faces:
        bm.faces.new([vs[i] for i in face])
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    mesh.add([v.co for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces], material,
             smooth=[abs(f.normal.z) > 0.1 and abs(f.normal.y) < 0.9 for f in bm.faces])
    bm.free()


def build_desk():
    curved_desk_band(0.78, 0.82, 0.75, "DeskTop", bevel=0.015)
    curved_desk_band(0.42, 0.77, 0.095, "DeskWood", bevel=0.008)
    curved_desk_band(0.14, 0.42, 0.10, "DeskNavy", bevel=0.008)
    curved_desk_band(0.12, 0.142, 0.103, "NeonLine")
    curved_desk_band(0.756, 0.767, 0.098, "NeonLine")
    for x in (-1.75, 1.75):
        box((x, 0.425, -0.365), (0.10, 0.69, 0.40), "DeskNavy", 0.025)
        box((x, 0.103, -0.37), (0.38, 0.046, 0.53), "ScreenFrame", 0.018)
    logo_frame = Frame((0, 0.494, 0.344))
    border(logo_frame, 1.2, 0.32, 0.022, 0.035, "ScreenFrame", z=-0.012, bevel=0.007)
    screen("DeskLogo", (0, 0.494, 0.349), 1.2, 0.32, material="DeskLogo")
    for side in (-1, 1):
        for layer in range(4):
            frame = Frame((side * 0.85 + 0.006 * layer, 0.8215 + layer * 0.0015, -0.12 + layer * 0.004),
                          yaw=math.radians(side * 5 + layer * 1.8))
            box((0, 0, 0), (0.21, 0.0015, 0.297), "Paper", frame=frame)
        pipe((side * 0.85 - 0.145, 0.831, -0.21), (side * 0.85 - 0.13, 0.831, -0.06), 0.0045, "Tablet", 10)
        pipe((side * 0.85 - 0.145, 0.831, -0.216), (side * 0.85 - 0.146, 0.831, -0.231), 0.0045, "ChairMetal", 10, 0.001)
    f = Frame((1.38, 0.96, -0.13), normal=(0, 0.82, -0.57))
    box((0, 0, -0.014), (0.29, 0.205, 0.017), "Tablet", 0.009, f)
    screen("TabletScreen", f.center, 0.263, 0.174, f)
    # A rear kickstand shares the tablet's frame; a separate pedestal reads as a loose box.
    attachment = f.point((0, 0.025, -0.020))
    foot = Vector((1.38, 0.824, 0.025))
    stand_axis = attachment - foot
    stand_frame = Frame((attachment + foot) / 2, normal=stand_axis)
    box((0, 0, 0), (0.095, 0.008, stand_axis.length), "Tablet", 0.003, stand_frame)
    box((1.38, 0.823, 0.025), (0.10, 0.006, 0.032), "Tablet", 0.002)


def chair_backrest(mesh, frame):
    low, high = 0.45, 1.10
    seams = (0.61, 0.765, 0.92)
    rows = {i / 32 for i in range(1, 32)}
    for t in (0.001, 0.003, 0.007, 0.015, 0.025):
        rows.update((t, 1 - t))
    for seam in seams:
        rows.update((seam + offset - low) / (high - low)
                    for offset in (-0.012, -0.007, -0.003, 0, 0.003, 0.007, 0.012))
    vertices = [(0, low, -0.255)]
    sides = 64
    for t in sorted(rows):
        y = low + (high - low) * t
        profile = (1 - abs(2 * t - 1) ** 8) ** 0.125
        half_width = 0.235 * (0.92 + 0.08 * t)
        for i in range(sides):
            angle = i * TAU / sides
            c, s = math.cos(angle), math.sin(angle)
            x = half_width * profile * math.copysign(abs(c) ** 0.75, c)
            thickness = 0.038 * profile * math.copysign(abs(s) ** 0.40, s)
            wrap = 0.085 * (x / half_width) ** 2
            lumbar = 0.010 * math.exp(-((y - 0.60) / 0.12) ** 2)
            front = max(0, s) ** 4
            fade = max(0, 1 - (x / half_width) ** 8)
            groove = 0.0035 * sum(math.exp(-((y - seam) / 0.0045) ** 2) for seam in seams)
            z = -0.255 + wrap + lumbar + thickness - front * fade * groove
            vertices.append((x, y, z))
    top = len(vertices)
    vertices.append((0, high, -0.255))
    faces = []
    for i in range(sides):
        nxt = (i + 1) % sides
        faces.append((0, 1 + i, 1 + nxt))
        for row in range(len(rows) - 1):
            a, b = 1 + row * sides + i, 1 + row * sides + nxt
            faces.append((a, a + sides, b + sides, b))
        last = 1 + (len(rows) - 1) * sides
        faces.append((top, last + nxt, last + i))
    # One continuous padded shell avoids the stepped silhouette of overlapping bevelled boxes.
    mesh.add(vertices, faces, "ChairLeather", frame, smooth=True)


def build_chairs():
    for side, name in ((-1, "ChairL"), (1, "ChairR")):
        origin = (side * 0.85, 0.08, -0.55)
        f = Frame(origin)
        m = node(name, origin)
        m.box((0, 0.44, 0), (0.52, 0.08, 0.48), "ChairLeather", 0.039, f, 5)
        m.box((0, 0.38, -0.02), (0.39, 0.045, 0.35), "LightBody", 0.018, f)
        chair_backrest(m, f)
        m.pipe((0, 0.12, 0), (0, 0.385, 0), 0.035, "ChairMetal", 20, frame=f)
        m.pipe((0, 0.115, 0), (0, 0.26, 0), 0.053, "LightBody", 20, frame=f)
        for i in range(5):
            a = i * TAU / 5
            p = Vector((0.29 * math.cos(a), 0.087, 0.29 * math.sin(a)))
            m.pipe((0, 0.13, 0), p, 0.019, "ChairMetal", 12, frame=f)
            tangent = Vector((-math.sin(a), 0, math.cos(a))) * 0.03
            wheel = Vector((p.x, 0.033, p.z))
            m.pipe(wheel - tangent, wheel + tangent, 0.033, "LightBody", 14, frame=f)
            m.pipe(p, wheel, 0.012, "ChairMetal", 10, frame=f)
        for x in (-0.273, 0.273):
            m.pipe((x * 0.7, 0.38, -0.08), (x, 0.608, -0.10), 0.012, "ChairMetal", 12, frame=f)
            m.sphere((x, 0.62, -0.10), (0.022, 0.016, 0.12), "ChairLeather", 24, 12, frame=f)


def build_video():
    f = Frame((0, 2.15, -3.2))
    screen("VideoWallScreen", f.center, 4.8, 2.7, f)
    border(f, 4.8, 2.7, 0.13, 0.25, "ScreenFrame", z=-0.08, bevel=0.018)
    border(f, 4.81, 2.71, 0.014, 0.018, "NeonLine", z=0.051, bevel=0.004)
    box((0, 2.15, -3.332), (4.82, 2.72, 0.035), "ScreenFrame", 0.01)
    for x in (-1.62, 1.62):
        box((x, 0.435, -3.29), (0.19, 0.71, 0.20), "ScreenFrame", 0.017)
        box((x, 0.095, -3.20), (0.68, 0.07, 0.70), "WhiteFrame", 0.025)
    for side, name in ((-1, "SideScreenL"), (1, "SideScreenR")):
        f = Frame((side * 3.75, 1.88, -2.5), yaw=math.radians(-side * 25))
        screen(name, f.center, 1.1, 1.96, f)
        border(f, 1.1, 1.96, 0.042, 0.10, "WhiteFrame", z=-0.025, bevel=0.012)
        box((0, 0, -0.081), (1.15, 2.0, 0.035), "ScreenFrame", 0.012, f)
        box((0, -1.40, -0.025), (0.095, 0.84, 0.095), "WhiteFrame", 0.01, f)
        box((0, -1.843, 0), (0.67, 0.07, 0.51), "WhiteFrame", 0.025, f)
    for side, name in ((-1, "FloorMonitorL"), (1, "FloorMonitorR")):
        f = Frame((side * 1.2, 0.293, 2.2), normal=(0, 0.74, -0.673))
        screen(name, f.center, 0.60, 0.3375, f)
        border(f, 0.60, 0.3375, 0.027, 0.10, "ScreenFrame", z=-0.035, bevel=0.01)
        box((0, 0, -0.09), (0.636, 0.374, 0.06), "ScreenFrame", 0.012, f)
        box((side * 1.2, 0.107, 2.25), (0.46, 0.054, 0.29), "LightBody", 0.018)
        pipe((side * 1.2, 0.125, 2.25), (side * 1.2, 0.235, 2.24), 0.023, "ScreenFrame")


def build_stage():
    pipe((0, 0.004, 0), (0, 0.073, 0), 3.6, "StageFloor", 256)
    group("StageRim").ring(3.603, 0.015, 0.027, 0.052, "StageRim", 256)
    # Individual raised tiles leave real 3 mm radial and concentric recessed joints.
    mesh = group("StageFloor")
    for ring, (r0, r1) in enumerate(((0.004, 1.196), (1.2, 2.396), (2.4, 3.586))):
        for sector in range(24):
            angle0 = sector * TAU / 24 + 0.0015 / max(r0, 0.5)
            angle1 = (sector + 1) * TAU / 24 - 0.0015 / max(r0, 0.5)
            points = []
            for r, direction in ((r0, range(13)), (r1, reversed(range(13)))):
                points.extend((r * math.sin(angle0 + (angle1 - angle0) * i / 12),
                               -r * math.cos(angle0 + (angle1 - angle0) * i / 12)) for i in direction)
            vertices = [(x, y, z) for y in (0.073, 0.08) for x, z in points]
            n = len(points)
            faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
            faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
            bm = bmesh.new()
            vs = [bm.verts.new(v) for v in vertices]
            for face in faces:
                bm.faces.new([vs[i] for i in face])
            bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
            bm.verts.ensure_lookup_table()
            bm.verts.index_update()
            mesh.add([v.co for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces], "StageFloor")
            bm.free()
    pipe((0, -0.09, 0), (0, 0, 0), 12, "StudioFloor", 256)
    group("NeonLine").ring(7.86, 0.035, 0.06, 0.084, "NeonLine", 192,
                           math.radians(-110), math.radians(110))
    group("WhiteFrame").ring(7.9, 0.13, 0, 0.06, "WhiteFrame", 192,
                             math.radians(-110), math.radians(110))


def cylinder_surface(mesh, radius, low, high, start, end, segments, material, uv=False):
    vertices = []
    for i in range(segments + 1):
        angle = start + (end - start) * i / segments
        vertices.extend([(radius * math.sin(angle), low, -radius * math.cos(angle)),
                         (radius * math.sin(angle), high, -radius * math.cos(angle))])
    faces = [(2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1) for i in range(segments)]
    uvs = [[(i / segments, 0), ((i + 1) / segments, 0), ((i + 1) / segments, 1), (i / segments, 1)]
           for i in range(segments)] if uv else None
    mesh.add(vertices, faces, material, smooth=True, uvs=uvs)


def build_enclosure():
    start, end = math.radians(-110), math.radians(110)
    cylinder_surface(group("Glass"), 8, 0.12, 5, start, end, 160, "Glass")
    for i in range(27):
        a = start + (end - start) * i / 26
        x, z = 8 * math.sin(a), -8 * math.cos(a)
        f = Frame((x, 2.5, z), yaw=-a)
        box((0, 0, 0), (0.052, 5, 0.09), "Mullion", 0.009, f)
    for y, depth in ((0.11, 0.18), (2.6, 0.05), (4.98, 0.09)):
        group("Mullion").ring(8, 0.085, y - depth / 2, y + depth / 2, "Mullion", 160, start, end)
    group("DeskNavy").ring(8.07, 0.28, 5, 5.8, "DeskNavy", 160, start, end)
    group("NeonLine").ring(7.92, 0.022, 5.03, 5.052, "NeonLine", 160, start, end)
    # The opaque audience-side arc closes the reverse/crane shots without a black void.
    cylinder_surface(group("DeskNavy"), 10.7, 0, 6, end, TAU + start, 112, "DeskNavy")
    # Radial returns close the setback between the glass and the larger front wall radius.
    for angle in (start, end):
        f = Frame((9.35 * math.sin(angle), 3, -9.35 * math.cos(angle)), yaw=-angle)
        box((0, 0, 0), (0.12, 6, 2.82), "DeskNavy", 0.012, f)
        box((0.07, 0, 1.26), (0.035, 5.6, 0.035), "WhiteFrame", 0.004, f)
    for y in (0.18, 2.65, 5.15):
        group("WhiteFrame").ring(10.65, 0.10, y, y + 0.10, "WhiteFrame", 112, end, TAU + start)
    for i in range(17):
        a = end + (TAU + start - end) * i / 16
        f = Frame((10.64 * math.sin(a), 2.7, -10.64 * math.cos(a)), yaw=-a)
        box((0, 0, 0), (0.075, 5.4, 0.075), "Mullion", 0.01, f)
        box((0.12, 0, 0.035), (0.017, 3.0, 0.02), "NeonLine", frame=f)
    city = node("CityBackdrop", (0, 0, 0))
    cylinder_surface(city, 11, -1, 8, -math.pi, math.pi, 256, "CityBackdrop", uv=True)
    city.extras["uv_direction"] = "u: left-to-right viewed from inside, v: bottom-to-top"
    box((0, 6.07, 0), (24, 0.14, 24), "Ceiling")


def build_botanicals():
    for side in (-1, 1):
        f = Frame((side * 5.5, 0, -4.7), yaw=math.radians(-side * 45))
        for i in range(27):
            box((-1.17 + i * 0.09, 1.68, 0), (0.04, 3.2, 0.04), "Hinoki", 0.003, f)
        for y in (0.105, 3.26):
            box((0, y, -0.025), (2.4, 0.05, 0.08), "Hinoki", 0.009, f)
        box((0, 0.175, 0.63), (2.10, 0.35, 0.95), "WhiteFrame", 0.07, f)
        for x, radius, dz in ((-0.61, 0.30, 0.0), (0.0, 0.38, -0.04), (0.62, 0.26, 0.06)):
            group("Moss").sphere((x, 0.35 + radius * 0.84, 0.63 + dz),
                                  (radius, radius * 0.85, radius * 0.9), "Moss", 24, 14, True, f)
        px, pz = side * 1.40, 0.65
        pipe((px, 0.015, pz), (px, 0.42, pz), 0.18, "Pot", 32, 0.25, f)
        pipe((px, 0.405, pz), (px, 0.424, pz), 0.239, "Moss", 32, frame=f)
        for stem in range(7):
            angle = stem * 2.4
            end = Vector((px + 0.24 * math.cos(angle), 1.15 + 0.34 * (stem % 3) / 2,
                          pz + 0.24 * math.sin(angle)))
            pipe((px, 0.40, pz), end, 0.009, "Leaf", 8, 0.004, f)
            for leaf_id in range(3):
                a = angle + leaf_id * 2.2
                base = end - Vector((0, leaf_id * 0.24, 0))
                direction = Vector((math.cos(a), 0.32, math.sin(a))).normalized()
                across = Vector((-math.sin(a), 0, math.cos(a)))
                length = 0.42 - leaf_id * 0.035
                vertices = [base, base + direction * length * 0.44 + across * 0.12,
                            base + direction * length + Vector((0, -0.09, 0)),
                            base + direction * length * 0.44 - across * 0.12,
                            base + direction * length * 0.46 + Vector((0, 0.045, 0))]
                group("Leaf").add(vertices, [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], "Leaf", f, True)


def build_lighting():
    group("WhiteFrame").ring(2.3, 0.35, 4.1, 4.22, "WhiteFrame", 192)
    group("Halo").ring(2.3, 0.29, 4.088, 4.102, "Halo", 192)
    for i in range(3):
        a = i * TAU / 3
        pipe((2.3 * math.sin(a), 4.22, 2.3 * math.cos(a)),
             (2.3 * math.sin(a), 6.0, 2.3 * math.cos(a)), 0.004, "Truss", 8)
    for i in range(-5, 6):
        offset = i * 1.5
        extent = math.sqrt(9 ** 2 - offset ** 2)
        pipe((offset, 5.60, -extent), (offset, 5.60, extent), 0.025, "Truss", 12)
        pipe((-extent, 5.66, offset), (extent, 5.66, offset), 0.025, "Truss", 12)
    for row in range(4):
        for col in range(5):
            x, z = (col - 2) * 2.25, -4.5 + row * 3
            center = Vector((x, 5.21, z))
            direction = Vector(((col % 2 - 0.5) * 1.7, 0.95, -0.25)) - center
            f = Frame(center, normal=direction)
            pipe((0, 0, -0.16), (0, 0, 0.15), 0.14, "LightBody", 24, frame=f)
            pipe((0, 0, 0.154), (0, 0, 0.163), 0.119, "LightLens", 24, frame=f)
            for zz in (-0.13, -0.05, 0.04, 0.125):
                pipe((0, 0, zz - 0.009), (0, 0, zz + 0.009), 0.15, "LightBody", 24, frame=f)
            for side in (-1, 1):
                box((side * 0.177, 0.09, -0.035), (0.024, 0.23, 0.045), "Truss", 0.006, f)
                box((side * 0.177, 0, 0.216), (0.12, 0.29, 0.017), "LightBody", 0.007, f)
            box((0, 0.205, -0.035), (0.37, 0.025, 0.045), "Truss", 0.005, f)
            for yy in (-0.174, 0.174):
                box((0, yy, 0.208), (0.28, 0.10, 0.016), "LightBody", 0.007, f)
            pipe(center + Vector((0, 0.18, 0)), (x, 5.60, z), 0.013, "Truss", 10)
    for x in (-2.25, -0.75, 0.75, 2.25):
        center = Vector((x, 4.97, 2.7))
        f = Frame(center, normal=Vector((x * 0.25, 1, -0.2)) - center)
        box((0, 0, -0.041), (1.0, 0.58, 0.09), "LightBody", 0.025, f)
        box((0, 0, 0.01), (0.94, 0.52, 0.012), "SoftPanel", 0.012, f)
        pipe(center, (x, 5.60, 2.7), 0.016, "Truss", 12)


def build_cameras():
    for i, x in enumerate((-1.6, 0, 1.6), 1):
        origin = (x, 0, 4.6)
        f = Frame(origin, normal=(-x, 0, -4.6))
        m = node("StudioCamera" + str(i), origin)
        for leg in range(3):
            a = leg * TAU / 3
            endpoint = Vector((0.39 * math.sin(a), 0.10, 0.39 * math.cos(a)))
            m.pipe((0, 0.15, 0), endpoint, 0.039, "CameraBody", 12, frame=f)
            tangent = Vector((math.cos(a), 0, -math.sin(a))) * 0.053
            wheel = Vector((endpoint.x, 0.066, endpoint.z))
            m.pipe(wheel - tangent, wheel + tangent, 0.066, "LightBody", 16, frame=f)
        m.pipe((0, 0.135, 0), (0, 0.74, 0), 0.104, "CameraBody", 24, frame=f)
        m.pipe((0, 0.74, 0), (0, 1.073, 0), 0.064, "ChairMetal", 24, frame=f)
        for k in range(64):
            a, b = k * TAU / 64, (k + 1) * TAU / 64
            m.pipe((0.235 * math.sin(a), 0.78, 0.235 * math.cos(a)),
                   (0.235 * math.sin(b), 0.78, 0.235 * math.cos(b)), 0.013, "CameraBody", 6, frame=f)
        m.box((0, 1.072, 0), (0.26, 0.11, 0.29), "CameraBody", 0.03, f)
        m.box((0, 1.20, -0.075), (0.29, 0.24, 0.41), "CameraBody", 0.032, f)
        m.box((-0.16, 1.20, -0.10), (0.027, 0.12, 0.20), "LightBody", 0.009, f)
        for j in range(6):
            m.box((-0.178, 1.19, -0.17 + j * 0.027), (0.008, 0.069, 0.009), "Truss", frame=f)
        m.pipe((0, 1.20, 0.115), (0, 1.20, 0.37), 0.078, "LightBody", 24, frame=f)
        m.pipe((0, 1.20, 0.366), (0, 1.20, 0.378), 0.069, "Prompter", 24, frame=f)
        for dx in (-0.09, 0.09):
            m.pipe((dx, 1.1, -0.19), (dx, 1.05, -0.53), 0.012, "Truss", 10, frame=f)
            m.pipe((dx, 1.05, -0.49), (dx, 1.045, -0.58), 0.019, "LightBody", 10, frame=f)
        m.box((0, 1.378, -0.18), (0.21, 0.12, 0.035), "CameraBody", 0.009, f)
        m.box((0, 1.378, -0.202), (0.179, 0.085, 0.008), "Screen", frame=f)
        m.box((0, 1.029, 0.36), (0.43, 0.044, 0.34), "LightBody", 0.01, f)
        # A sloped thin mirror stays separate from the surrounding opaque hood surfaces.
        mirror = [(-0.2, 1.04, 0.49), (0.2, 1.04, 0.49), (0.2, 1.39, 0.27), (-0.2, 1.39, 0.27)]
        m.add(mirror, [(0, 1, 2, 3)], "Prompter", f)
        for side in (-1, 1):
            m.add([(side * 0.217, 1.025, 0.12), (side * 0.217, 1.025, 0.51),
                   (side * 0.217, 1.413, 0.29), (side * 0.217, 1.413, 0.12)],
                  [(0, 1, 2, 3)] if side > 0 else [(3, 2, 1, 0)], "LightBody", f)
        m.box((0, 1.414, 0.21), (0.45, 0.018, 0.22), "LightBody", 0.005, f)


def create_materials():
    specs = {
        "DeskTop": ((0.86, 0.90, 0.91), 0.05, 0.20),
        "DeskWood": ((0.65, 0.43, 0.22), 0, 0.44),
        "DeskNavy": ((0.012, 0.029, 0.065), 0.32, 0.31),
        "DeskLogo": ((0.018, 0.052, 0.095), 0.18, 0.32),
        "NeonLine": ((0.28, 0.69, 1.0), 0.1, 0.28, 3.5),
        "StageRim": ((0.24, 0.66, 1.0), 0.1, 0.25, 4.0),
        "StageFloor": ((0.019, 0.041, 0.079), 0.30, 0.22),
        "StudioFloor": ((0.008, 0.014, 0.025), 0.25, 0.25),
        "Screen": ((0.016, 0.075, 0.20), 0, 0.40),
        "ScreenFrame": ((0.011, 0.028, 0.055), 0.70, 0.28),
        "WhiteFrame": ((0.81, 0.86, 0.88), 0.15, 0.30),
        "Glass": ((0.14, 0.25, 0.34), 0.05, 0.12),
        "Mullion": ((0.014, 0.029, 0.044), 0.65, 0.28),
        "CityBackdrop": ((0.007, 0.019, 0.039), 0, 0.85),
        "Hinoki": ((0.71, 0.49, 0.27), 0, 0.48),
        "Moss": ((0.075, 0.19, 0.031), 0, 0.91),
        "Leaf": ((0.043, 0.17, 0.055), 0, 0.55),
        "Pot": ((0.67, 0.72, 0.70), 0, 0.62),
        "Truss": ((0.045, 0.063, 0.079), 0.75, 0.33),
        "LightBody": ((0.009, 0.013, 0.018), 0.3, 0.44),
        "LightLens": ((0.77, 0.87, 1), 0.05, 0.23, 2.5),
        "SoftPanel": ((0.90, 0.94, 1), 0, 0.30, 3.0),
        "Halo": ((0.79, 0.91, 1), 0, 0.24, 4.0),
        "CameraBody": ((0.040, 0.055, 0.069), 0.45, 0.38),
        "Prompter": ((0.14, 0.24, 0.29), 0.20, 0.12),
        "ChairLeather": ((0.012, 0.016, 0.022), 0, 0.38),
        "ChairMetal": ((0.55, 0.62, 0.68), 0.92, 0.20),
        "Paper": ((0.88, 0.88, 0.82), 0, 0.80),
        "Tablet": ((0.029, 0.040, 0.056), 0.68, 0.29),
        "Ceiling": ((0.005, 0.007, 0.011), 0, 0.87),
    }
    result = {}
    for name, spec in specs.items():
        rgb, metal, rough = spec[:3]
        mat = bpy.data.materials.new(name)
        mat.diffuse_color = (*rgb, 1)
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = (*rgb, 1)
        bsdf.inputs["Metallic"].default_value = metal
        bsdf.inputs["Roughness"].default_value = rough
        is_emissive = len(spec) == 4
        if is_emissive:
            bsdf.inputs["Emission Color"].default_value = (*rgb, 1)
            bsdf.inputs["Emission Strength"].default_value = spec[3]
        is_glass = name in ("Glass", "Prompter")
        if is_glass:
            bsdf.inputs["Alpha"].default_value = 0.12 if name == "Glass" else 0.24
            mat.surface_render_method = "DITHERED"
            mat.diffuse_color = (*rgb, bsdf.inputs["Alpha"].default_value)
        mat.use_backface_culling = name not in ("Glass", "Prompter", "Leaf", "LightBody")
        result[name] = mat
    return result


def read_glb(path):
    raw = path.read_bytes()
    magic, version, size = struct.unpack_from("<4sII", raw)
    assert (magic, version, size) == (b"glTF", 2, len(raw))
    length, kind = struct.unpack_from("<I4s", raw, 12)
    assert kind == b"JSON"
    return json.loads(raw[20:20 + length]), raw[28 + length:]


def accessor_values(doc, binary, index):
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    channels = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[acc["type"]]
    code = {5126: "f", 5125: "I", 5123: "H", 5121: "B"}[acc["componentType"]]
    fmt = "<" + code * channels
    stride = view.get("byteStride", struct.calcsize(fmt))
    offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return [struct.unpack_from(fmt, binary, offset + i * stride) for i in range(acc["count"])]


def validate_export(path, objects):
    doc, binary = read_glb(path)
    assert not any(doc.get(key) for key in ("animations", "cameras", "images", "textures", "skins"))
    assert "KHR_lights_punctual" not in doc.get("extensionsUsed", [])
    assert "KHR_draco_mesh_compression" not in doc.get("extensionsUsed", [])
    assert {n["name"] for n in doc["nodes"]} == set(MESHES)
    result = {}
    for n in doc["nodes"]:
        name = n["name"]
        assert not any(key in n for key in ("rotation", "scale", "matrix", "children")), n
        translation = n.get("translation", [0, 0, 0])
        assert all(abs(translation[i] - MESHES[name].origin[i]) < 1e-5 for i in range(3))
        positions, materials, triangles = [], [], 0
        for prim in doc["meshes"][n["mesh"]]["primitives"]:
            assert prim.get("mode", 4) == 4
            assert not prim.get("extensions")
            attrs = prim["attributes"]
            pts = accessor_values(doc, binary, attrs["POSITION"])
            positions.extend(pts)
            indices = accessor_values(doc, binary, prim["indices"])
            triangles += len(indices) // 3
            materials.append(doc["materials"][prim["material"]]["name"])
            is_screen = name in SCREEN_SIZES
            if is_screen:
                assert len(pts) == 4 and len(indices) == 6
                uv = accessor_values(doc, binary, attrs["TEXCOORD_0"])
                assert set(uv) == {(0, 0), (1, 0), (1, 1), (0, 1)}
                source = MESHES[name]
                for p, t in zip(pts, uv):
                    world = Vector(p) + Vector(translation)
                    corner = min(range(4), key=lambda j: (source.vertices[j] - world).length)
                    assert t == ((0, 0), (1, 0), (1, 1), (0, 1))[corner]
            is_main_screen = name == "VideoWallScreen"
            if is_main_screen:
                normals = accessor_values(doc, binary, attrs["NORMAL"])
                assert all(p[2] > 0.999 for p in normals)
            is_city = name == "CityBackdrop"
            if is_city:
                normals = accessor_values(doc, binary, attrs["NORMAL"])
                assert all(p[0] * normal[0] + p[2] * normal[2] < -10.9 for p, normal in zip(pts, normals))
            is_floor = name in ("Studio_StageFloor", "Studio_StudioFloor")
            if is_floor:
                assert "TEXCOORD_0" not in attrs
        source_obj = next(o for o in objects if o.name == name)
        assert len(source_obj.modifiers) == 0
        result[name] = {"triangles": triangles, "vertices": len(positions),
                        "source_vertices": len(source_obj.data.vertices), "materials": sorted(set(materials)),
                        "translation": [round(v, 6) for v in translation],
                        "bbox_local": bounds(positions),
                        "bbox_world": bounds([tuple(p[i] + translation[i] for i in range(3)) for p in positions]),
                        "extras": n.get("extras", {})}
    for name, size in SCREEN_SIZES.items():
        assert result[name]["extras"]["screen_size"] == list(size)
    assert sum(n["triangles"] for n in result.values()) <= 150000
    assert path.stat().st_size <= 4000000, path.stat().st_size
    return result


def preview_materials(materials):
    for name in ("DeskWood", "Hinoki"):
        mat = materials[name]
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        coord = nodes.new("ShaderNodeTexCoord")
        mapping = nodes.new("ShaderNodeVectorMath")
        mapping.operation = "MULTIPLY"
        mapping.inputs[1].default_value = (3, 80, 2) if name == "DeskWood" else (85, 85, 1.7)
        links.new(coord.outputs["Object"], mapping.inputs[0])
        noise = nodes.new("ShaderNodeTexNoise")
        noise.inputs["Scale"].default_value = 2.8
        noise.inputs["Detail"].default_value = 2
        links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
        ramp = nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.elements[0].position = 0.18
        ramp.color_ramp.elements[0].color = (0.26, 0.14, 0.055, 1)
        ramp.color_ramp.elements[1].position = 0.82
        ramp.color_ramp.elements[1].color = (0.79, 0.58, 0.33, 1)
        links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
        bsdf = nodes.get("Principled BSDF")
        links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    mat = materials["Screen"]
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    coord = nodes.new("ShaderNodeTexCoord")
    split = nodes.new("ShaderNodeSeparateXYZ")
    links.new(coord.outputs["UV"], split.inputs["Vector"])
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.003, 0.026, 0.12, 1)
    ramp.color_ramp.elements[1].color = (0.027, 0.23, 0.53, 1)
    links.new(split.outputs["Y"], ramp.inputs["Fac"])
    # Preview displays use emission alone so studio key lights cannot wash out the signal.
    shader = nodes.new("ShaderNodeEmission")
    links.new(ramp.outputs["Color"], shader.inputs["Color"])
    shader.inputs["Strength"].default_value = 0.9
    links.new(shader.outputs["Emission"], nodes.get("Material Output").inputs["Surface"])
    moss = materials["Moss"]
    nodes, links = moss.node_tree.nodes, moss.node_tree.links
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 85
    noise.inputs["Detail"].default_value = 3
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.5
    bump.inputs["Distance"].default_value = 0.015
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], nodes.get("Principled BSDF").inputs["Normal"])
    preview_city(materials["CityBackdrop"])


def preview_city(material):
    # A generated review-only skyline makes glass readable without shipping a texture.
    width, height = 2048, 512
    pixels = [0.0] * (width * height * 4)
    for y in range(height):
        t = y / height
        color = (0.008 + 0.008 * t, 0.020 + 0.013 * t, 0.047 + 0.027 * t, 1)
        for x in range(width):
            k = (y * width + x) * 4
            pixels[k:k + 4] = color
    for b in range(145):
        x0 = RNG.randrange(width)
        w, h = RNG.randrange(6, 30), RNG.randrange(75, 290)
        for y in range(35, h):
            for x in range(x0, min(width, x0 + w)):
                k = (y * width + x) * 4
                is_window = (x - x0) % 5 < 2 and y % 9 < 3 and RNG.random() > 0.28
                color = (0.20, 0.32, 0.39, 1) if is_window else (0.009, 0.017, 0.029, 1)
                is_warm = is_window and b % 4 == 0
                if is_warm:
                    color = (0.45, 0.30, 0.13, 1)
                pixels[k:k + 4] = color
    image = bpy.data.images.new("PreviewCityOnly", width=width, height=height)
    image.pixels.foreach_set(pixels)
    nodes, links = material.node_tree.nodes, material.node_tree.links
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    shader = nodes.new("ShaderNodeEmission")
    links.new(tex.outputs["Color"], shader.inputs["Color"])
    shader.inputs["Strength"].default_value = 0.8
    links.new(shader.outputs["Emission"], nodes.get("Material Output").inputs["Surface"])


def setup_preview(materials, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.seed = 73017
    scene.cycles.max_bounces = 6
    scene.cycles.transparent_max_bounces = 12
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_percentage = 100
    scene.view_settings.view_transform = "AgX"
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.055, 0.086, 0.15, 1)
    background.inputs["Strength"].default_value = 0.20
    # Review materials use Blender's native bottom-left UV convention after export.
    for obj in bpy.data.objects:
        has_uv = obj.type == "MESH" and obj.data.uv_layers.active is not None
        if has_uv:
            for loop in obj.data.uv_layers.active.data:
                loop.uv.y = 1 - loop.uv.y
    preview_materials(materials)
    for i, (position, target, power, size, color) in enumerate([
        ((-2.3, 4.8, 2.5), (0, 0.8, -0.4), 950, 3, (0.86, 0.92, 1)),
        ((2.3, 4.8, 2.5), (0, 0.8, -0.4), 850, 3, (0.86, 0.92, 1)),
        ((0, 4.8, -2.2), (0, 0.8, -0.2), 650, 2, (0.55, 0.72, 1)),
        ((-5, 4.6, -2.0), (-5.5, 1.4, -4.7), 650, 2.5, (1, 0.83, 0.64)),
        ((5, 4.6, -2.0), (5.5, 1.4, -4.7), 650, 2.5, (1, 0.83, 0.64)),
        ((0, 5.3, 6.5), (0, 1, 3.5), 1400, 5, (0.66, 0.78, 1)),
        ((0, 3.6, 4.3), (0, 0.45, 0), 250, 3, (0.80, 0.89, 1)),
    ]):
        data = bpy.data.lights.new("PreviewArea" + str(i), "AREA")
        data.energy, data.shape, data.size, data.color = power, "DISK", size, color
        obj = bpy.data.objects.new(data.name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = game_to_blender(position)
        obj.rotation_euler = (game_to_blender(target) - obj.location).to_track_quat("-Z", "Y").to_euler()
    camera_data = bpy.data.cameras.new("PreviewCamera")
    camera = bpy.data.objects.new("PreviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    return camera


def render_previews(objects, materials, directory, samples, selected):
    camera = setup_preview(materials, samples)
    scene = bpy.context.scene
    shots = [
        ("main_front", (0, 1.25, 4.6), (0, 1.35, -2), 45),
        ("main_two_shot_side", (3, 1.6, 3.6), (-0.2, 1.2, -1), 40),
        ("wide_crane", (5.2, 3.4, 7.8), (0, 1.2, -1), 55),
        ("wide_reverse", (-2.5, 2.2, 1), (2.5, 1.4, 6), 60),
        ("desk_close", (0.9, 1.15, 1.6), (0.85, 0.85, 0), 40),
        ("top", (0, 26, 0.001), (0, 0, 0), 60),
        ("review_anchor_close", (-1.08, 1.36, 3.95), (-0.6, 1.2, -0.55), 12.5),
        ("review_two_shot", (0, 1.45, 4.4), (0, 1.15, -0.6), 24),
        ("review_chair_detail", (-0.25, 1.22, 0.72), (-0.85, 0.83, -0.72), 32),
    ]
    info = {}
    for name, eye, target, angle in shots:
        should_skip = selected and name not in selected
        if should_skip:
            continue
        is_top = name == "top"
        for obj in objects:
            obj.hide_render = is_top and obj.name == "Studio_Ceiling"
        camera.location = game_to_blender(eye)
        camera.rotation_euler = (game_to_blender(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.type = "ORTHO" if is_top else "PERSP"
        # three.js PerspectiveCamera.fov is vertical; Blender's angle defaults to horizontal.
        camera.data.sensor_fit = "VERTICAL"
        camera.data.sensor_height = 24
        camera.data.lens = 12 / math.tan(math.radians(angle) / 2)
        camera.data.ortho_scale = 25
        is_camera_station = name in ("main_front", "review_two_shot")
        camera.data.clip_start = 0.8 if is_camera_station else 0.025
        camera.data.clip_end = 100
        scene.render.resolution_x, scene.render.resolution_y = (1600, 1600) if is_top else (1600, 900)
        scene.render.filepath = str(directory / (name + ".png"))
        bpy.ops.render.render(write_still=True)
        info[name] = {"eye": eye, "target": target, "vertical_fov_degrees": angle,
                      "clip_start": camera.data.clip_start, "ceiling_cutaway": is_top,
                      "resolution": [scene.render.resolution_x, scene.render.resolution_y]}
    return info


def main():
    started = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-previews", action="store_true")
    parser.add_argument("--verify-repeat", action="store_true",
                        help="Rebuild and verify the previous GLB hash while preserving rendered preview statistics.")
    parser.add_argument("--samples", type=int, choices=range(32, 65), default=32)
    parser.add_argument("--views", nargs="*", default=[])
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    stats_path = PREVIEW_DIR / "stats.json"
    previous_stats = json.loads(stats_path.read_text()) if stats_path.exists() else {}
    previous_previews = {}
    has_selected_views = bool(args.views) and stats_path.exists()
    if has_selected_views:
        previous_previews = previous_stats.get("previews", {})
    output = ROOT / "packages/web/public/models/news-studio.glb"
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1
    materials = create_materials()
    for build in (build_stage, build_desk, build_chairs, build_video, build_enclosure,
                  build_botanicals, build_lighting, build_cameras):
        build()
    objects = [mesh.finish(materials) for mesh in MESHES.values()]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB", use_selection=True,
                              export_yup=True, export_extras=True, export_texcoords=True,
                              export_normals=True, export_materials="EXPORT", export_attributes=False,
                              export_animations=False, export_cameras=False, export_lights=False,
                              export_draco_mesh_compression_enable=False)
    nodes = validate_export(output, objects)
    for name in ("ChairL", "ChairR"):
        assert abs(nodes[name]["bbox_world"]["max"][1] - 1.18) < 1e-5, name
    for side, name in ((-1, "FloorMonitorL"), (1, "FloorMonitorR")):
        expected = (side * 1.2, 0.293, 2.2)
        assert all(abs(a - b) < 1e-5 for a, b in zip(nodes[name]["translation"], expected)), name
    review1 = {"chair_backrest_top_above_stage_m": 1.10, "chair_backrest_top_above_seat_m": 0.62,
               "chair_backrest_center_thickness_m": 0.076, "chair_backrest_seam_count": 3,
               "chair_armrest_top_world_m": 0.716, "desktop_underside_world_m": 0.78,
               "tablet_support": "rear-centred attached kickstand; no pedestal box",
               "floor_monitor_centres": [[-1.2, 0.293, 2.2], [1.2, 0.293, 2.2]],
               "exported_chair_height_and_floor_monitor_position_checks": "pass"}
    glb_sha256 = hashlib.sha256(output.read_bytes()).hexdigest()
    if args.verify_repeat:
        assert previous_stats.get("glb_sha256") == glb_sha256, "Fresh export must match the previous GLB byte-for-byte"
        previous_stats["reproducibility"] = {"previous_glb_sha256": glb_sha256, "matches_previous_export": True,
                                              "method": "Independent factory-startup Blender process; fresh GLB SHA-256 comparison"}
        previous_stats["review1"] = review1
        previous_stats["repeat_check_seconds"] = round(time.monotonic() - started, 3)
        stats_path.write_text(json.dumps(previous_stats, indent=2) + "\n")
        print(json.dumps(previous_stats, indent=2), flush=True)
        return
    stats = {"coordinate_system": "+X right, +Y up, +Z front; metres", "seed": 73017,
             "review1": review1,
             "nodes": nodes, "node_count": len(nodes), "material_count": len(materials),
             "total_triangles": sum(n["triangles"] for n in nodes.values()),
             "total_vertices": sum(n["vertices"] for n in nodes.values()),
             "glb_bytes": output.stat().st_size, "glb_sha256": glb_sha256,
             "geometry_export_seconds": round(time.monotonic() - started, 3),
             "validation": {"budget": "pass", "node_origins_and_identity_rotation_scale": "pass",
                            "screen_uv_orientation_and_extras": "pass", "city_inward_normals": "pass",
                            "no_floor_uv": "pass", "no_cameras_lights_animation_compression_images": "pass"},
             "preview_notes": ["Main front and review two-shot near clip 0.8m avoid the co-located physical centre camera.",
                               "Perspective FOV is vertical, matching three.js PerspectiveCamera.fov.",
                               "Top is a ceiling-only cutaway; rig and halo remain visible.",
                               "Wood, moss, blue gradients and placeholder skyline shading are preview-only.",
                               "Exported screen and city UVs use the requested bottom-left (0,0), top-right (1,1)."]}
    stats["previews"] = previous_previews
    stats["reproducibility"] = {
        "previous_glb_sha256": previous_stats.get("glb_sha256"),
        "matches_previous_export": previous_stats.get("glb_sha256") == stats["glb_sha256"],
    }
    stats["reused_preview_names"] = sorted(set(previous_previews) - set(args.views))
    stats_path.write_text(json.dumps(stats, indent=2) + "\n")
    if not args.skip_previews:
        stats["previews"].update(render_previews(objects, materials, PREVIEW_DIR, args.samples, args.views))
    stats["total_seconds"] = round(time.monotonic() - started, 3)
    stats_path.write_text(json.dumps(stats, indent=2) + "\n")
    print(json.dumps(stats, indent=2), flush=True)


if __name__ == "__main__":
    main()
