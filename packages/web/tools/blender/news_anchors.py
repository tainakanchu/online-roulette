# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic seated news presenters, authored in metres, +Y up / +Z forward.

Blender -b --factory-startup -noaudio --python news_anchors.py -- [options]
The eight unparented meshes have translation-only transforms. Body extras contain
world-space pivots. To turn a face, rotate Head, Mouth and Lids around head_joint;
Mouth's local Y scale animates speech, and Lids visibility animates blinking.
The exported Mouth and Lids have unit scale; hide both initially in the scene.
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
from mathutils import Matrix, Vector
from mathutils.geometry import tessellate_polygon

ROOT = Path(__file__).resolve().parents[4]
PREVIEW_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "news-anchors"
TAU = math.tau


def game_to_blender(point):
    x, y, z = point
    return Vector((x, -z, y))


def blender_to_game(point):
    return (point[0], point[2], -point[1])


def mix(a, b, t):
    return a * (1 - t) + b * t


def srgb(value):
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def material(name, color, roughness=0.6, metallic=0):
    color = tuple(srgb(int(color[i:i + 2], 16) / 255) for i in (0, 2, 4))
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    mat.use_backface_culling = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Specular IOR Level"].default_value = .10 if name in ("HairM", "HairF", "Iris", "Pupil") else (.22 if roughness > .4 else .4)
    return mat


def create_materials():
    specs = {
        "Skin": ("d9a183", .62), "HairM": ("141210", .72),
        "HairF": ("2b1a12", .70), "Brow": ("35231e", .7),
        "Lips": ("a96059", .58), "EyeWhite": ("eee8df", .3),
        "Iris": ("50352b", .48), "Pupil": ("120e0c", .50),
        "MouthInner": ("38171d", .8), "Teeth": ("f4eadd", .4),
        "SuitM": ("1c2433", .78), "Shirt": ("f6f4ee", .7),
        "Tie": ("6e283e", .63), "JacketF": ("e9e2d6", .76),
        "Blouse": ("cfdbe6", .65), "SkirtF": ("383b44", .8),
        "Shoes": ("19191c", .32), "Watch": ("929ba6", .28, .8),
    }
    return {name: material(name, *spec) for name, spec in specs.items()}


class Mesh:
    def __init__(self, name):
        self.name = name
        self.vertices = []
        self.faces = []
        self.materials = []
        self.smooth = []

    def add(self, vertices, faces, mat, smooth=True):
        offset = len(self.vertices)
        self.vertices.extend(Vector(v) for v in vertices)
        self.faces.extend(tuple(offset + i for i in face) for face in faces)
        self.materials.extend([mat] * len(faces))
        self.smooth.extend([smooth] * len(faces))

    def ellipsoid(self, center, radii, mat, segments=24, bands=12):
        vertices = [(center[0], center[1] + radii[1], center[2])]
        for row in range(1, bands):
            phi = math.pi * row / bands
            for col in range(segments):
                theta = TAU * col / segments
                vertices.append((center[0] + radii[0] * math.sin(phi) * math.cos(theta),
                                 center[1] + radii[1] * math.cos(phi),
                                 center[2] + radii[2] * math.sin(phi) * math.sin(theta)))
        vertices.append((center[0], center[1] - radii[1], center[2]))
        faces = []
        for col in range(segments):
            nxt = (col + 1) % segments
            faces.append((0, 1 + nxt, 1 + col))
            for row in range(bands - 2):
                a, b = 1 + row * segments + col, 1 + row * segments + nxt
                faces.append((a, b, b + segments, a + segments))
            a, b = 1 + (bands - 2) * segments + col, 1 + (bands - 2) * segments + nxt
            faces.append((len(vertices) - 1, a, b))
        self.add(vertices, faces, mat)

    def loft(self, rows, mat, segments=40, flatten=1):
        vertices, faces = [], []
        for x, y, z, rx, rz in rows:
            for col in range(segments):
                a = TAU * col / segments
                c = math.cos(a)
                depth = math.copysign(abs(c) ** flatten, c)
                vertices.append((x + rx * math.sin(a), y, z + rz * depth))
        for row in range(len(rows) - 1):
            for col in range(segments):
                a, b = row * segments + col, row * segments + (col + 1) % segments
                faces.append((a, b, b + segments, a + segments))
        faces.extend([tuple(reversed(range(segments))), tuple(range(len(vertices) - segments, len(vertices)))])
        self.add(vertices, faces, mat)

    def tube(self, points, widths, mat, sides=12, depth=1):
        vertices, faces = [], []
        previous_u = None
        for i, point in enumerate(points):
            tangent = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(i - 1, 0)])
            tangent.normalize()
            reference = Vector((0, 0, 1))
            parallel = abs(tangent.dot(reference)) > .92
            if parallel:
                reference = Vector((1, 0, 0))
            u = tangent.cross(reference).normalized()
            has_previous = previous_u is not None
            if has_previous:
                transported = previous_u - tangent * previous_u.dot(tangent)
                usable = transported.length > .01
                if usable:
                    u = transported.normalized()
            previous_u = u
            v = tangent.cross(u).normalized()
            for col in range(sides):
                theta = TAU * col / sides
                vertices.append(Vector(point) + widths[i] * (u * math.cos(theta) + depth * v * math.sin(theta)))
        for row in range(len(points) - 1):
            for col in range(sides):
                a, b = row * sides + col, row * sides + (col + 1) % sides
                faces.append((a, b, b + sides, a + sides))
        faces.extend([tuple(reversed(range(sides))), tuple(range(len(vertices) - sides, len(vertices)))])
        self.add(vertices, faces, mat)

    def panel(self, points, mat, thickness=.002):
        n = len(points)
        vertices = list(points) + [(x, y, z - thickness) for x, y, z in points]
        faces = [tuple(range(n)), tuple(reversed(range(n, 2 * n)))]
        faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
        self.add(vertices, faces, mat, False)

    def finish(self, mats, origin):
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata([game_to_blender(v - Vector(origin)) for v in self.vertices], [], self.faces)
        mesh.update()
        names = list(dict.fromkeys(self.materials))
        for name in names:
            mesh.materials.append(mats[name])
        for poly, name, smooth in zip(mesh.polygons, self.materials, self.smooth):
            poly.material_index = names.index(name)
            poly.use_smooth = smooth
        # Recalculate each disconnected solid instead of relying on loft winding.
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = game_to_blender(origin)
        return obj


def curve(points, steps=7):
    """Catmull-Rom interpolation, with repeated endpoints for a stable tangent."""
    values = [Vector(points[0]), *[Vector(p) for p in points], Vector(points[-1])]
    out = []
    for i in range(1, len(values) - 2):
        a, b, c, d = values[i - 1:i + 3]
        for j in range(steps):
            t = j / steps
            out.append(.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t ** 3))
    out.append(Vector(points[-1]))
    return out


class Anchor:
    def __init__(self, female):
        self.female = female
        self.prefix = "AnchorF_" if female else "AnchorM_"
        self.x = .85 if female else -.85
        self.dy = -.06 if female else 0
        self.sx = .94 if female else 1
        self.dz = .125 if female else .105
        self.collar_raise = .016 if female else .030
        self.hair = "HairF" if female else "HairM"
        self.joint = (self.x, 1.238 + self.dy, -.455 + self.dz)
        self.body = Mesh(self.prefix + "Body")
        self.head = Mesh(self.prefix + "Head")
        self.mouth = Mesh(self.prefix + "Mouth")
        self.lids = Mesh(self.prefix + "Lids")
        self.face_rows = [
            (1.178, .017, -.441, .043), (1.187, .039, -.437, .060),
            (1.203, .057, -.439, .069), (1.224, .068, -.442, .077),
            (1.250, .076, -.444, .081), (1.276, .081, -.446, .084),
            (1.300, .080, -.447, .082), (1.324, .078, -.448, .082),
            (1.350, .076, -.450, .083), (1.374, .067, -.454, .080),
            (1.395, .047, -.456, .062), (1.409, .013, -.456, .023),
        ]

    def p(self, x, y, z):
        return (self.x + x * self.sx, y + self.dy, z + self.dz)

    def section(self, y):
        for a, b in zip(self.face_rows, self.face_rows[1:]):
            within = a[0] <= y <= b[0]
            if within:
                t = (y - a[0]) / (b[0] - a[0])
                return tuple(mix(a[i], b[i], t) for i in (1, 2, 3))
        return self.face_rows[-1][1:]

    def relief(self, x, y):
        def bump(cx, cy, wx, wy):
            return math.exp(-((x - cx) / wx) ** 2 - ((y - cy) / wy) ** 2)
        cheeks = sum(.0080 * bump(side * .046, 1.271, .025, .022) for side in (-1, 1))
        sockets = sum(-.0052 * bump(side * .0345, 1.301, .021, .012) for side in (-1, 1))
        brows = sum(.0025 * bump(side * .033, 1.320, .027, .009) for side in (-1, 1))
        muzzle = .0042 * bump(0, 1.235, .029, .019)
        chin = .0050 * bump(0, 1.197, .031, .013)
        bridge = .0160 * bump(0, 1.285, .012, .027)
        tip = .0290 * bump(0, 1.258, .0105, .013)
        wings = sum(.0120 * bump(side * .012, 1.253, .0065, .007) for side in (-1, 1))
        return cheeks + sockets + brows + muzzle + chin + bridge + tip + wings

    def face_z(self, x, y):
        rx, cz, rz = self.section(y)
        return cz + rz * max(.001, 1 - (x / rx) ** 2) ** .40 + self.relief(x, y)

    def face_p(self, x, y, lift=0):
        return self.p(x, y, self.face_z(x, y) + lift)

    def make_face(self):
        # Continuous skin carries the nose and orbital relief; a pasted-on patch leaves a paper edge.
        vertices, faces = [], []
        rings, segments = 44, 60
        levels = [1.178 + .062 * i / 10 for i in range(10)]
        levels += [1.240 + .084 * i / 23 for i in range(23)]
        levels += [1.324 + .085 * i / 10 for i in range(11)]
        for row, y in enumerate(levels):
            rx, cz, rz = self.section(y)
            for col in range(segments):
                theta = (TAU * col / segments + math.pi) % TAU - math.pi
                frontal = abs(theta) < math.pi / 2
                if frontal:
                    theta = math.copysign(math.pi / 2 * (abs(theta) / (math.pi / 2)) ** 1.45, theta)
                x = rx * math.sin(theta)
                c = math.cos(theta)
                z = cz + rz * math.copysign(abs(c) ** .8, c)
                forward = c > 0
                if forward:
                    z += self.relief(x, y) * min(1, c * 3)
                vertices.append(self.p(x, y, z))
        for row in range(rings - 1):
            for col in range(segments):
                a, b = row * segments + col, row * segments + (col + 1) % segments
                faces.append((a, b, b + segments, a + segments))
        faces.extend([tuple(reversed(range(segments))), tuple(range(len(vertices) - segments, len(vertices)))])
        self.head.add(vertices, faces, "Skin")
        neck = .044 if self.female else .058
        self.head.loft([(self.x, y + self.dy, z + self.dz, rx * self.sx, rz) for y, z, rx, rz in
                        [(1.111, -.465, neck * .92, neck * .85), (1.152, -.462, neck, neck * .90),
                         (1.183, -.456, neck * .84, neck * .78), (1.223, -.449, neck * .68, neck * .72)]], "Skin", 32)
        for side in (-1, 1):
            self.head.ellipsoid(self.p(side * .081, 1.264, -.451), (.015, .029, .018), "Skin", 20, 10)
            ear = [self.p(side * x, y, z) for x, y, z in
                   [(.083, 1.245, -.431), (.091, 1.255, -.431), (.092, 1.276, -.438), (.084, 1.282, -.436)]]
            path = curve(ear, 5)
            self.head.tube(path, [.0025] * len(path), "Skin", 8)
            self.head.ellipsoid(self.p(side * .084, 1.257, -.431), (.004, .008, .0025), "Lips", 12, 8)
            self.make_eye(side)
            self.head.ellipsoid(self.face_p(side * .0108, 1.249, .0005), (.0027, .0013, .0010), "Lips", 12, 6)
        self.make_lips()
        self.make_hair()

    def make_eye(self, side):
        ex, ey = side * .0345, 1.300
        eye_z = self.face_z(ex, ey) + .0102
        w = .0165 if self.female else .0155
        upper_height, lower_height = .0042, .0051

        def aperture(u, upper):
            height = upper_height if upper else -lower_height
            return ey + height * max(0, 1 - u * u) ** .675 + side * .0006 * u

        # The inner lash edge covers about 18% of the iris diameter; white never surrounds it.
        # A skin strip bridges the shallow eyeball to the socket instead of a floating outline.
        segments, rings = 32, 3
        vertices = [self.p(ex, ey, eye_z - .0003)]
        faces = []
        for row in range(1, rings + 1):
            r = row / rings
            for col in range(segments):
                theta = TAU * col / segments
                u, v = math.cos(theta), math.sin(theta)
                y = mix(ey, aperture(u, v >= 0), r)
                vertices.append(self.p(ex + w * r * u, y, eye_z - .0003 - .0004 * r * r))
        for col in range(segments):
            nxt = (col + 1) % segments
            faces.append((0, 1 + col, 1 + nxt))
            for row in range(rings - 1):
                a, b = 1 + row * segments + col, 1 + row * segments + nxt
                faces.append((a, a + segments, b + segments, b))
        self.head.add(vertices, faces, "EyeWhite")
        for mat, radius, lift in [("Iris", .0054, 0), ("Pupil", .00265, .0005)]:
            vertices = [self.p(ex, ey, eye_z + lift)]
            for j in range(32):
                theta = TAU * j / 32
                x = ex + radius * math.cos(theta)
                u = (x - ex) / w
                y = max(aperture(u, False), min(aperture(u, True), ey + radius * math.sin(theta)))
                vertices.append(self.p(x, y, eye_z + lift))
            self.head.add(vertices, [(0, j + 1, (j + 1) % 32 + 1) for j in range(32)], mat)
        for upper in (False, True):
            path, vertices, faces = [], [], []
            # Extra upper rows make a shallow fold 3 mm above the lash margin.
            offsets = (0, .0020, .0030, .0040, .0065) if upper else (0, .0030, .0050)
            for j in range(17):
                u = -1 + 2 * j / 16
                x, y = ex + w * u, aperture(u, upper)
                edge_z = eye_z + .0007
                path.append(self.p(x, y, edge_z))
                for row, offset in enumerate(offsets):
                    py = y + (1 if upper else -1) * offset * max(.25, 1 - u * u) ** .3
                    blend = offset / offsets[-1]
                    z = mix(edge_z, self.face_z(x, py) + .0004, blend)
                    folded = upper and row in (1, 2, 3)
                    if folded:
                        z += (.0006, -.0006, .0003)[row - 1] * (1 - u * u)
                    vertices.append(self.p(x, py, z))
            stride = len(offsets)
            for j in range(16):
                for row in range(stride - 1):
                    a = j * stride + row
                    faces.append((a, a + stride, a + stride + 1, a + 1))
            self.head.add(vertices, faces, "Skin")
            self.head.tube(path, [.00055] * len(path), "Skin", 6)
            if upper:
                # Put lashes in front of the lid, thickening toward the outer canthus.
                lash = [Vector(p) + Vector((0, 0, .0006)) for p in path]
                widths = [.00075 + .00025 * ((side * (-1 + 2 * j / 16) + 1) / 2) ** 2 for j in range(17)]
                self.head.tube(lash, widths, "Brow", 6)
                outer = lash[-1] if side > 0 else lash[0]
                length = .0045 if self.female else .0025
                tail = [outer, outer + Vector((side * length * .55, .0008, 0)),
                        outer + Vector((side * length, .0017 if self.female else .0010, -.0003))]
                self.head.tube(tail, [.0010, .0007, .00015], "Brow", 6)
        # Closed lids cover the full new rim, including the lowered upper edge and lashes.
        width, height = w + .003, .0088
        vertices = [self.p(ex, ey, eye_z + .0040)]
        faces = []
        for row in range(1, 5):
            r = row / 4
            for col in range(40):
                theta = TAU * col / 40
                u, v = math.cos(theta), math.sin(theta)
                x = ex + width * r * u
                y = ey + height * r * math.copysign(abs(v) ** 1.35, v)
                vertices.append(self.p(x, y, eye_z + .0035 + .0005 * (1 - r * r)))
        for col in range(40):
            nxt = (col + 1) % 40
            faces.append((0, 1 + col, 1 + nxt))
            for row in range(3):
                a, b = 1 + row * 40 + col, 1 + row * 40 + nxt
                faces.append((a, a + 40, b + 40, b))
        self.lids.add(vertices, faces, "Skin")
        brow = []
        for j in range(21):
            t = j / 20
            x = side * (.017 + .034 * t)
            y = 1.319 + .0045 * math.sin(math.pi * t) - .0025 * t
            brow.append(self.face_p(x, y, .0027))
        widths = [.0009 + .0022 * math.sin(math.pi * (j + 1) / 23) ** .6 for j in range(21)]
        self.head.tube(brow, widths, "Brow", 8, .48)
        blink_path = [self.face_p(ex + w * u, ey - .0017 * (1 - u * u), .0108 - .003 * u * u) for u in [-1 + j / 10 for j in range(21)]]
        blink_path = [(x, y, max(z, eye_z + self.dz + .0042)) for x, y, z in blink_path]
        self.lids.tube(blink_path, [.00065] * len(blink_path), "Brow", 6)

    def make_lips(self):
        width = .022 if self.female else .024
        center_y = 1.226
        for upper in (False, True):
            vertices, faces = [], []
            for j in range(33):
                u = -1 + j / 16
                x = u * width
                line = center_y + .002 * u * u
                cupid = .0014 * math.exp(-((abs(u) - .30) / .18) ** 2)
                height = (.003 + cupid if upper else -.0042) * max(0, 1 - u * u) ** .7
                for row in range(4):
                    t = row / 3
                    y = line + t * height
                    z = .0015 + .0025 * math.sin(math.pi * t) * (1 - u * u)
                    vertices.append(self.face_p(x, y, z))
            for j in range(32):
                for r in range(3):
                    a = j * 4 + r
                    faces.append((a, a + 4, a + 5, a + 1))
            self.head.add(vertices, faces if upper else [tuple(reversed(f)) for f in faces], "Lips")
        line = [self.face_p(width * u, center_y + .002 * u * u, .0020) for u in [-1 + j / 16 for j in range(33)]]
        self.head.tube(line, [.00045] * len(line), "MouthInner", 6)
        # Preserve the published animation pivots when sculpting the surrounding face.
        self.mouth_center = self.p(0, center_y, -.35577793845258793)
        opening = .020 if self.female else .022
        # Every overlay follows the lip surface; one planar mouth would sink at its corners.
        verts = [self.mouth_center]
        for j in range(48):
            theta = TAU * j / 48
            x, y = width * math.cos(theta), center_y + opening / 2 * math.sin(theta)
            verts.append(self.p(x, y, self.face_z(x, center_y) + .0055))
        self.mouth.add(verts, [(0, j + 1, (j + 1) % 48 + 1) for j in range(48)], "MouthInner")
        teeth = []
        for j in range(25):
            u = -1 + j / 12
            x = width * .83 * u
            top = center_y + opening * .5 * math.sqrt(max(0, 1 - (.83 * u) ** 2)) - .0008
            for y in (top - .0033, top):
                teeth.append(self.p(x, y, self.face_z(x, center_y) + .006))
        self.mouth.add(teeth, [(j * 2, j * 2 + 2, j * 2 + 3, j * 2 + 1) for j in range(24)], "Teeth")
        self.lids_center = self.p(0, 1.300, -.36947835410492424)

    def make_hair(self):
        # Seven broad waves carry volume; high-frequency parallel grooves read as molded plastic.
        segments, bands = 64, 18
        vertices, faces = [], []
        for row in range(bands + 1):
            t = row / bands
            for j in range(segments):
                theta = TAU * j / segments
                signed = (theta + math.pi) % TAU - math.pi
                front = max(0, math.cos(theta))
                part = math.exp(-((signed - .32) / .25) ** 2)
                sweep = math.exp(-((signed + .52) / .50) ** 2)
                edge = 1.85 - .68 * front ** .65 - .20 * part + (.015 if self.female else .12) * sweep - (.08 * front if self.female else 0)
                phi = .018 + t * edge
                flow = theta + .23 * math.sin(phi) * front
                y = 1.302 + .123 * math.cos(phi)
                wave = .0028 * math.cos(7 * theta + 3.0 * phi + .45 * math.sin(theta * 3)) * math.sin(phi)
                # The side part tapers away at the crown, without eight separate raised tubes.
                thickness = .006 + wave - .0015 * part * math.sin(phi)
                x = (.087 + wave) * math.sin(phi) * math.sin(flow)
                z = -.455 + (.100 + wave) * math.sin(phi) * math.cos(flow)
                on_cranium = y <= 1.409
                rx, cz, rz = self.section(y) if on_cranium else (0, -.456, 0)
                shell_x = max(.088 * math.sin(phi), rx + .005 if on_cranium else 0)
                shell_z = max(.101 * math.sin(phi), rz + .005 if on_cranium else 0)
                x = (shell_x + wave) * math.sin(flow)
                c = math.cos(flow)
                z = cz + (shell_z + wave) * math.copysign(abs(c) ** .8, c)
                vertices.append(self.p(x, y, z))
        for row in range(bands):
            for j in range(segments):
                a, b = row * segments + j, row * segments + (j + 1) % segments
                faces.append((a, a + segments, b + segments, b))
        faces.append(tuple(reversed(range(segments))))
        if self.female:
            # Shared boundary vertices keep the crown and bob one continuous surface.
            first, last = 9, 55
            previous = [bands * segments + j for j in range(first, last + 1)]
            bases = [Vector(vertices[index]) for index in previous]
            borders = [[previous[0]], [previous[-1]]]
            for row in range(1, 18):
                t = row / 17
                current = []
                for j, base in zip(range(first, last + 1), bases):
                    theta = TAU * j / segments
                    # Four broad masses over the back/side arc drift along their length.
                    flow = 5 * theta + .65 * math.sin(t * math.pi * 1.4)
                    lock = .5 + .5 * math.cos(flow)
                    tip_y = 1.110 + .018 * (.5 + .5 * math.cos(5 * theta + .8))
                    target = Vector(self.p(.078 * math.sin(theta), tip_y,
                                           -.461 + .080 * math.copysign(abs(math.cos(theta)) ** .8, math.cos(theta))))
                    point = base.lerp(target, t)
                    swell = .020 * math.sin(math.pi * t)
                    masses = .005 * math.cos(flow) * math.sin(math.pi * t) ** .7
                    # Staggered overlapping bulges end at different heights, without hard shelf edges.
                    layers = sum(.0025 * math.exp(-((t - center - .035 * math.cos(theta * 3)) / .070) ** 2)
                                 for center in (.56, .79)) * lock
                    curl = -.007 * max(0, (t - .78) / .22) ** 2
                    bulge = swell + masses + layers + curl
                    point.x += self.sx * bulge * math.sin(theta)
                    point.z += .9 * bulge * math.cos(theta)
                    current.append(len(vertices))
                    vertices.append(point)
                for j in range(last - first):
                    faces.append((previous[j], current[j], current[j+1], previous[j+1]))
                borders[0].append(current[0])
                borders[1].append(current[-1])
                previous = current
            # Roll the exposed edges inward so the side locks do not end as paper sheets.
            for border in borders:
                rolled = []
                for index in border:
                    point = Vector(vertices[index])
                    side = 1 if point.x > self.x else -1
                    row = [index]
                    for step in range(1, 4):
                        angle = math.pi * step / 3
                        offset = Vector((-side * .0025 * math.sin(angle), 0,
                                         -.0025 * (1 - math.cos(angle))))
                        row.append(len(vertices))
                        vertices.append(point + offset)
                    rolled.append(row)
                for a, b in zip(rolled, rolled[1:]):
                    for j in range(3):
                        faces.append((a[j], b[j], b[j+1], a[j+1]))
        self.head.add(vertices, faces, self.hair)
        # Broad, shallow ribbons blend over the shell, rather than round parallel tubes.
        def shell_front(x, y):
            phi = math.acos(max(-1, min(1, (y - 1.302) / .123)))
            on_cranium = y <= 1.409
            rx, cz, rz = self.section(y) if on_cranium else (0, -.456, 0)
            rx = max(.088 * math.sin(phi), rx + .005 if on_cranium else 0)
            rz = max(.101 * math.sin(phi), rz + .005 if on_cranium else 0)
            theta = math.asin(max(-.995, min(.995, x / max(.001, rx))))
            wave = .0028 * math.cos(7 * theta + 3 * phi + .45 * math.sin(theta * 3)) * math.sin(phi)
            return cz + (rz + wave) * max(.003, 1 - (x / max(.001, rx + wave)) ** 2) ** .4
        for i in range(5):
            left_sweep = i < 3
            if left_sweep:
                t = i / 2
                controls = [(.027 + .007 * t, 1.392 + .009 * t),
                            (-.010 - .013 * t, 1.380 + .010 * t),
                            (-.065 - .008 * t, 1.335 + .012 * t)]
                width = .010
            else:
                t = i - 3
                controls = [(.032 + .004 * t, 1.388 + .010 * t),
                            (.058 + .004 * t, 1.366 + .005 * t),
                            (.077, 1.323 + .018 * t)]
                width = .008
            path = curve(controls, 6)
            vertices, faces = [], []
            for row, point in enumerate(path):
                t = row / (len(path) - 1)
                direction = path[min(row + 1, len(path) - 1)] - path[max(0, row - 1)]
                direction.normalize()
                perpendicular = Vector((-direction.y, direction.x))
                half = .001 + width * math.sin(math.pi * t) ** .55
                for col in range(7):
                    u = -1 + col / 3
                    x, y = point + perpendicular * half * u
                    lift = .0011 + .0018 * (1 - u * u) * math.sin(math.pi * t)
                    vertices.append(self.p(x, y, shell_front(x, y) + lift))
            for row in range(len(path) - 1):
                for col in range(6):
                    a = row * 7 + col
                    face = (a, a + 7, a + 8, a + 1)
                    points = [Vector(vertices[k]) for k in face[:3]]
                    forward = (points[1] - points[0]).cross(points[2] - points[0]).z > 0
                    faces.append(face if forward else tuple(reversed(face)))
            self.head.add(vertices, faces, self.hair)
        if not self.female:
            for side in (-1, 1):
                self.head.ellipsoid(self.p(side * .0805, 1.296, -.448), (.0055, .022, .010), self.hair, 16, 8)
            return
    def make_body(self):
        body, female = self.body, self.female
        suit = "JacketF" if female else "SuitM"
        # Only the upper torso follows the six-degree forward lean; hips stay on the seat.
        shoulder = 1.105 + self.dy + self.collar_raise
        half = .151 if female else .174
        rows = [(self.x, .575, -.55, .143, .106), (self.x, .626, -.545, .157, .110),
                (self.x, .724, -.526, .145, .100), (self.x, .843 + self.dy * .3, -.507, .160, .108),
                (self.x, 1.012 + self.dy + self.collar_raise, -.485, half, .102),
                (self.x, shoulder - .010, -.477, half, .096),
                (self.x, shoulder + .018, -.473, .124 if female else .145, .070),
                (self.x, shoulder + .030, -.473, .056 if female else .065, .055)]
        rows = [(self.x, y, z + self.dz, rx, rz) for y, z, rx, rz in curve([r[1:] for r in rows], 3)]
        body.loft(rows, suit, 48, .65)
        neck = .044 if female else .059
        body.loft([(self.x, shoulder, -.473 + self.dz, neck, neck * .88),
                   (self.x, shoulder + .021, -.457 + self.dz, neck * .94, neck * .87)], "Skin", 32)
        body.loft([(self.x, shoulder + .007, -.469 + self.dz, neck + .003, neck * .9 + .003),
                   (self.x, shoulder + .032, -.463 + self.dz, neck + .001, neck * .9 + .001)],
                  "Blouse" if female else "Shirt", 40)
        def chest_z(x, y):
            level = max(rows[0][1], min(rows[-1][1] - .00001, y))
            for a, b in zip(rows, rows[1:]):
                within = a[1] <= level <= b[1]
                if within:
                    t = (level - a[1]) / (b[1] - a[1])
                    z, rx, rz = (mix(a[i], b[i], t) for i in (2, 3, 4))
                    return z + rz * max(.001, 1 - ((x - self.x) / rx) ** 2) ** .325
            return -.39

        def cloth(points, mat, thickness=.003):
            lift = {"Shirt": .010, "Blouse": .010, "Tie": .018, suit: .015}.get(mat, .012)
            small_decoration = mat == "Shirt" and max(v[0] for v in points) - min(v[0] for v in points) < .008
            collar = mat == "Shirt" and min(v[1] for v in points) > 1.065 + self.dy + self.collar_raise
            if small_decoration or collar:
                lift = .021
            triangles = tessellate_polygon([[Vector(v) for v in points]])
            verts, faces = [], []
            for triangle in triangles:
                a, b, c = triangle
                uses_indices = isinstance(a, int)
                if uses_indices:
                    a, b, c = (Vector(points[k]) for k in triangle)
                steps = 9
                indices = {}
                for i in range(steps + 1):
                    for j in range(steps + 1 - i):
                        v = a + (b - a) * i / steps + (c - a) * j / steps
                        v.z = chest_z(v.x, v.y) + lift
                        indices[i,j] = len(verts)
                        verts.append(v)
                for i in range(steps):
                    for j in range(steps - i):
                        faces.append((indices[i,j], indices[i+1,j], indices[i,j+1]))
                        has_second = i + j < steps - 1
                        if has_second:
                            faces.append((indices[i+1,j], indices[i+1,j+1], indices[i,j+1]))
            forward = []
            for f in faces:
                a,b,c = (verts[k] for k in f)
                forward.append(f if (b-a).cross(c-a).z > 0 else tuple(reversed(f)))
            body.add(verts, forward, mat)
            border = [(v[0],v[1],chest_z(v[0],v[1]) + lift - .0002) for v in points]
            # A tiny rounded hem gives layered cloth a thickness without beveled polygons.
            body.tube(border + border[:1], [.0008] * (len(border) + 1), mat, 6)

        shirt = "Blouse" if female else "Shirt"
        def p(x, y, z):
            return (self.x + x, y + self.dy + self.collar_raise, z + self.dz)
        cloth([p(-.061, 1.134, -.414), p(.061, 1.134, -.414), p(.083, 1.071, -.386),
                    p(.027, .920, -.390), p(-.044, .919, -.389), p(-.082, 1.071, -.386)], shirt)
        for side in (-1, 1):
            cloth([p(side * .047, 1.137, -.413), p(side * .066, 1.125, -.405),
                        p(side * .128, 1.055, -.382), p(side * .099, 1.036, -.373),
                        p(side * .112, 1.010, -.373), p(side * .009, .875, -.391),
                        p(side * .045, 1.043, -.366)], suit, .005)
        if female:
            neckline = [p(.046 * math.cos(math.pi * j / 24), 1.100 - .019 * math.sin(math.pi * j / 24), -.377) for j in range(25)]
            body.tube(neckline, [.003] * len(neckline), "Blouse", 8)
            body.ellipsoid(p(.028, .872, -.389), (.006, .006, .003), "JacketF", 16, 8)
        else:
            for side in (-1, 1):
                cloth([p(side * .010, 1.125, -.397), p(side * .043, 1.148, -.421),
                            p(side * .061, 1.125, -.397), p(side * .035, 1.071, -.363)], "Shirt", .003)
            cloth([p(-.012, 1.112, -.378), p(.013, 1.112, -.378), p(.015, 1.091, -.368),
                        p(0, 1.079, -.366), p(-.014, 1.092, -.368)], "Tie", .006)
            cloth([p(-.009, 1.083, -.371), p(.010, 1.083, -.371), p(.021, .927, -.374),
                        p(.003, .901, -.377), p(-.018, .924, -.374)], "Tie", .004)
            for row in range(8):
                for side in (-1, 1):
                    x, y = side * .006 + (.002 if row % 2 else 0), 1.064 - row * .019
                    cloth([p(x, y + .0017, -.368), p(x + .0012, y, -.368), p(x, y - .0017, -.368), p(x - .0012, y, -.368)], "Shirt", .0002)
            for y in (.867, .796):
                body.ellipsoid(p(.015, y, -.394 if y > .83 else -.407), (.007, .007, .003), "SuitM", 16, 8)
            cloth([p(-.132, 1.029, -.377), p(-.067, 1.029, -.377), p(-.067, 1.035, -.377), p(-.132, 1.035, -.377)], "SuitM")
            cloth([p(-.122, 1.035, -.379), p(-.099, 1.048, -.381), p(-.076, 1.035, -.379)], "Shirt")
        self.pose = {}
        for side in (-1, 1):
            arm_x = .137 if female else .156
            elbow_x = .153 if female else .173
            upper_radius = .046 if female else .056
            shoulder_center = (self.x + side * arm_x, shoulder - .006, -.477 + self.dz)
            elbow = (self.x + side * elbow_x, .826, -.256)
            wrist = (self.x + side * .154, .854, -.076)
            controls = [(self.x + side * (arm_x - .010), shoulder - .012, -.477 + self.dz),
                        (self.x + side * arm_x, shoulder - .058, -.463 + self.dz),
                        (self.x + side * (arm_x + .010), mix(shoulder, .826, .48), mix(-.477 + self.dz, -.256, .48)),
                        (self.x + side * elbow_x, .868, -.271), elbow,
                        (self.x + side * elbow_x, .852, -.208),
                        (self.x + side * .161, .857, -.135), wrist]
            radii = [upper_radius * .68, upper_radius * .95, upper_radius, .037 if female else .041,
                     .032 if female else .035, .027, .026, .025]
            path = curve(controls, 4)
            widths = []
            for j in range(len(path)):
                q = j / (len(path) - 1) * (len(radii) - 1)
                k = min(len(radii) - 2, int(q))
                widths.append(mix(radii[k], radii[k + 1], q - k))
            body.tube(path, widths, suit, 24)
            cuff_end = (self.x + side * .153, .854, -.066)
            body.tube([wrist, cuff_end], [.0248, .024], shirt, 24, .82)
            hand = (self.x + side * .150, .854, -.025)
            body.tube([cuff_end, (hand[0], .854, -.039)], [.021, .023], "Skin", 20, .82)
            body.ellipsoid(hand, (.030, .020, .038), "Skin", 28, 12)
            for finger in range(4):
                dx = (finger - 1.5) * .013
                reach = [.036, .047, .044, .034][finger]
                x = hand[0] + dx
                controls = [(x, .857, .002), (x + dx * .025, .858, .017),
                            (x + dx * .04, .849, .015 + reach * .63),
                            (x + dx * .03, .834, .010 + reach),
                            (x + dx * .02, .833, .006 + reach)]
                path = curve(controls, 3)
                widths = [mix(.007, .0035, j / (len(path) - 1)) for j in range(len(path))]
                body.tube(path, widths, "Skin", 10)
            thumb = [(hand[0] - side * .021, .855, -.031), (hand[0] - side * .035, .848, -.009),
                     (hand[0] - side * .034, .838, .007), (hand[0] - side * .027, .837, .013)]
            path = curve(thumb, 4)
            body.tube(path, [mix(.009, .004, j / (len(path) - 1)) for j in range(len(path))], "Skin", 12)
            watch_side = not female and side == -1
            if watch_side:
                body.ellipsoid((wrist[0], .880, -.069), (.019, .004, .015), "Watch", 24, 8)
                body.ellipsoid((wrist[0], .884, -.069), (.014, .001, .010), "SuitM", 20, 6)
            upper = Vector(shoulder_center) - Vector(elbow)
            fore = Vector(wrist) - Vector(elbow)
            self.pose = {"shoulder_center": list(shoulder_center), "elbow_center": list(elbow),
                         "wrist_center": list(wrist), "hand_center": list(hand),
                         "upper_arm_forward_degrees": round(math.degrees(math.atan2(abs(upper.z), upper.y)), 2),
                         "elbow_degrees": round(math.degrees(upper.angle(fore)), 2),
                         "upper_arm_diameter_m": upper_radius * 2,
                         "chest_to_desk_edge_m": round(-.2 - chest_z(self.x, shoulder - .06), 4),
                         "cuff_exposure_m": .010}
        shoulder_points = [v for v in body.vertices if shoulder - .075 < v.y < shoulder + .030]
        self.pose["shoulder_width_m"] = round(max(v.x for v in shoulder_points) - min(v.x for v in shoulder_points), 4)
        self.make_legs()

    def make_legs(self):
        mat = "SkirtF" if self.female else "SuitM"
        for side in (-1, 1):
            x = self.x + side * (.080 if self.female else .088)
            centers = [(x, .645, -.557 + self.dz), (x, .631, -.411 + self.dz * .6), (x, .591, -.220),
                       (x, .522, -.130), (x, .376, -.142), (x, .151, -.156)]
            path = curve(centers, 5)
            widths = [.089, .087, .077, .067, .057, .037]
            radii = []
            for j in range(len(path)):
                q = j / (len(path) - 1) * (len(widths) - 1)
                k = min(len(widths) - 2, int(q))
                radii.append(mix(widths[k], widths[k + 1], q - k))
            self.body.tube(path, radii, mat, 28)
            self.body.ellipsoid((x, .128, -.096), (.047, .038, .117), "Shoes", 28, 12)
            self.body.loft([(x, .085, -.092, .046, .114), (x, .100, -.092, .048, .116)], "Shoes", 32)
            self.body.tube([(x, .186, -.112), (x, .330, -.081), (x, .464, -.066)], [.0012] * 3, mat, 6)

    def finish(self, mats):
        self.make_body()
        self.make_face()
        objects = [self.body.finish(mats, (self.x, .08, -.55)), self.head.finish(mats, self.joint),
                   self.mouth.finish(mats, self.mouth_center), self.lids.finish(mats, self.lids_center)]
        for key, value in {"head_joint": self.joint, "mouth_center": self.mouth_center, "lids_center": self.lids_center}.items():
            objects[0][key] = list(value)
        objects[0]["coordinate_system"] = "+Y up, +Z forward; pivots are world-space metres"
        objects[0]["standing_height_m"] = 1.62 if self.female else 1.74
        objects[0]["seated_eye_height_m"] = 1.30 + self.dy
        objects[0]["pose_measurements"] = self.pose
        objects[0]["overlay_default"] = "Mouth hidden (or local Y scale 0); Lids hidden"
        return objects


def validate_open_eyes(objects):
    """Verify exposed pupils, iris contact with lids, and unobstructed female eyes."""
    bpy.context.view_layer.update()
    count = 0
    for female in (False, True):
        prefix = "AnchorF_" if female else "AnchorM_"
        head = next(obj for obj in objects if obj.name == prefix + "Head")
        x, ey, sx = (.85, 1.24, .94) if female else (-.85, 1.30, 1)
        for side in (-1, 1):
            ex = x + side * .0345 * sx
            samples = [(ex, ey, {"Pupil"}), (ex, ey - .0040, {"Iris"}),
                       (ex, ey + .0060, {"Skin"}), (ex, ey + .0042, {"Brow"})]
            for offset in (-.011, .011):
                samples.append((ex + offset * sx, ey, {"EyeWhite"}))
            for px, py, expected in samples:
                origin = game_to_blender((px, py, 1)) - head.location
                hit, location, normal, face = head.ray_cast(origin, game_to_blender((0, 0, -1)), distance=2)
                material = head.data.materials[head.data.polygons[face].material_index].name if hit else "miss"
                assert hit and material in expected, (prefix, px, py, expected, material)
                count += 1
    return count


def validate_overlays(objects):
    bpy.context.view_layer.update()
    graph = bpy.context.evaluated_depsgraph_get()
    count = 0
    for female in (False, True):
        prefix = "AnchorF_" if female else "AnchorM_"
        x = .85 if female else -.85
        y = 1.24 if female else 1.30
        sx = .94 if female else 1
        samples = []
        for side in (-1, 1):
            for j in range(12):
                theta = TAU * j / 12
                samples.append((x + side * .0345 * sx + .0046 * math.cos(theta), y + .0046 * math.sin(theta), "Lids"))
            width = .0165 if female else .0155
            for u in (-.85, -.5, 0, .5, .85):
                for v in (-.0048, .0042):
                    samples.append((x + (side * .0345 + width * u) * sx,
                                    y + v * max(0, 1 - u * u) ** .675 + side * .0006 * u, "Lids"))
        for dx in (-.012, 0, .012):
            for dy in (-.003, 0, .003):
                samples.append((x + dx, y - .074 + dy, "Mouth"))
        for px, py, suffix in samples:
            hit, location, normal, index, obj, matrix = bpy.context.scene.ray_cast(
                graph, game_to_blender((px, py, 1)), game_to_blender((0, 0, -1)), distance=2)
            assert hit and obj.name == prefix + suffix, (prefix, suffix, px, py, obj.name if hit else "miss")
            count += 1
    return count


def bounds(points):
    return {"min": [round(min(p[i] for p in points), 6) for i in range(3)],
            "max": [round(max(p[i] for p in points), 6) for i in range(3)]}


def read_glb(path):
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data)
    assert (magic, version, length) == (b"glTF", 2, len(data))
    size, kind = struct.unpack_from("<I4s", data, 12)
    assert kind == b"JSON"
    return json.loads(data[20:20 + size]), data[28 + size:]


def accessor_values(doc, binary, index):
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    n = {"SCALAR": 1, "VEC3": 3}[acc["type"]]
    code = {5126: "f", 5125: "I", 5123: "H"}[acc["componentType"]]
    fmt = "<" + code * n
    stride = view.get("byteStride", struct.calcsize(fmt))
    offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return [struct.unpack_from(fmt, binary, offset + i * stride) for i in range(acc["count"])]


def validate_export(path, objects):
    doc, binary = read_glb(path)
    assert not any(doc.get(k) for k in ("animations", "skins", "cameras", "images", "textures", "extensionsRequired"))
    assert len(doc["nodes"]) == 8
    assert {n["name"] for n in doc["nodes"]} == {o.name for o in objects}
    stats = {}
    for node in doc["nodes"]:
        name = node["name"]
        source = next(o for o in objects if o.name == name)
        assert not any(k in node for k in ("rotation", "scale", "matrix", "children", "skin")), node
        translation = node.get("translation", [0, 0, 0])
        expected = blender_to_game(source.location)
        assert all(abs(a - b) < 1e-6 for a, b in zip(translation, expected))
        positions, normals, mats, triangles = [], [], [], 0
        for prim in doc["meshes"][node["mesh"]]["primitives"]:
            assert prim.get("mode", 4) == 4 and not prim.get("targets")
            positions.extend(accessor_values(doc, binary, prim["attributes"]["POSITION"]))
            normals.extend(accessor_values(doc, binary, prim["attributes"]["NORMAL"]))
            triangles += doc["accessors"][prim["indices"]]["count"] // 3
            mats.append(doc["materials"][prim["material"]]["name"])
        assert all(abs(sum(v * v for v in normal) - 1) < .001 for normal in normals)
        is_head = name.endswith("Head")
        if is_head:
            assert triangles <= 16000, (name, triangles)
        stats[name] = {"triangles": triangles, "vertices": len(positions), "source_vertices": len(source.data.vertices),
                       "translation": [round(v, 7) for v in translation], "bbox_local": bounds(positions),
                       "bbox_world": bounds([tuple(p[i] + translation[i] for i in range(3)) for p in positions]),
                       "materials": sorted(set(mats)), "extras": node.get("extras", {})}
    for prefix in ("AnchorM_", "AnchorF_"):
        total = sum(s["triangles"] for name, s in stats.items() if name.startswith(prefix))
        assert total <= 40000, (prefix, total)
        body = stats[prefix + "Body"]
        for key, suffix in [("head_joint", "Head"), ("mouth_center", "Mouth"), ("lids_center", "Lids")]:
            assert all(abs(a - b) < 1e-6 for a, b in zip(body["extras"][key], stats[prefix + suffix]["translation"]))
    assert path.stat().st_size <= 3_000_000
    return stats


def preview_box(name, center, dimensions, mat, mats):
    x, y, z = center
    dx, dy, dz = (d / 2 for d in dimensions)
    mesh = Mesh(name)
    mesh.add([(x + i * dx, y + j * dy, z + k * dz) for i, j, k in
              [(-1,-1,-1), (1,-1,-1), (1,1,-1), (-1,1,-1), (-1,-1,1), (1,-1,1), (1,1,1), (-1,1,1)]],
             [(0,3,2,1), (4,5,6,7), (0,1,5,4), (1,2,6,5), (2,3,7,6), (3,0,4,7)], mat, False)
    return mesh.finish(mats, (0, 0, 0))


def setup_preview(mats, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.seed = 29
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("PreviewNavyWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (.015, .024, .055, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = .35
    scene.world = world
    mats["PreviewDesk"] = material("PreviewDesk", "e8e8e4", .5)
    mats["PreviewChair"] = material("PreviewChair", "283143", .8)
    mats["PreviewFloor"] = material("PreviewFloor", "080e1d", .9)
    mats["PreviewPaper"] = material("PreviewPaper", "f6f2eb", .9)
    # An annular strip approximates the shared set's curved desk envelope.
    mesh = Mesh("PreviewDesk")
    vertices, faces = [], []
    for y in (.784, .82):
        for j in range(65):
            x = -1.57 + 3.14 * j / 64
            arc = -.035 * (x / 1.57) ** 2
            vertices.extend([(x, y, -.20 + arc), (x, y, .55 + arc)])
    for j in range(64):
        a = j * 2
        faces.extend([(a,a+2,a+3,a+1), (a+130,a+131,a+133,a+132),
                      (a,a+130,a+132,a+2), (a+1,a+3,a+133,a+131)])
    faces.extend([(0,1,131,130), (128,258,259,129)])
    mesh.add(vertices, faces, "PreviewDesk", False)
    mesh.finish(mats, (0,0,0))
    preview_box("PreviewFloor", (0,.05,-.3), (30,.06,30), "PreviewFloor", mats)
    preview_box("PreviewBackdrop", (0,4,-2.5), (30,10,.01), "PreviewFloor", mats)
    for x in (-.85, .85):
        preview_box("PreviewSeat", (x,.505,-.55), (.40,.11,.38), "PreviewChair", mats)
        preview_box("PreviewSeatBase", (x,.29,-.55), (.06,.42,.06), "PreviewChair", mats)
        preview_box("PreviewSeatFoot", (x,.095,-.55), (.39,.03,.37), "PreviewChair", mats)
        preview_box("PreviewScript", (x,.823,.032), (.197,.004,.258), "PreviewPaper", mats)
        for j in range(9):
            preview_box("PreviewScriptInk", (x-.008,.8254,.115-j*.020), (.152 if j else .103,.0005,.002), "PreviewChair", mats)
    for name, position, power, size, tint in [
        ("Key", (-2.3,3.4,2.3), 460, 3.0, (1,.89,.80)),
        ("Fill", (2.8,2.6,1.4), 330, 2.8, (.80,.88,1)),
        ("Rim", (.1,2.9,-2.0), 560, 2.2, (.76,.84,1)),
    ]:
        bpy.ops.object.light_add(type="AREA", location=game_to_blender(position))
        light = bpy.context.object
        light.name = "Preview" + name
        light.data.energy, light.data.shape, light.data.size = power, "DISK", size
        light.data.color = tint
        light.rotation_euler = (game_to_blender((0,1,-.4)) - light.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.name = "PreviewCamera"
    camera.data.lens_unit = "FOV"
    camera.data.sensor_fit = "HORIZONTAL"
    scene.camera = camera
    return camera


def render(camera, directory, name, eye, target, fov):
    camera.location = game_to_blender(eye)
    camera.rotation_euler = (game_to_blender(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.angle = math.radians(fov)
    bpy.context.scene.render.filepath = str(directory / name)
    bpy.ops.render.render(write_still=True)


def render_previews(objects, mats, directory, samples, selected):
    camera = setup_preview(mats, samples)
    lookup = {o.name: o for o in objects}
    for obj in objects:
        obj.hide_render = obj.name.endswith(("Mouth", "Lids"))
    shots = [
        ("two_shot", (0,1.25,4.6), (0,1.1,-.6), 40),
        ("close_m", (-.85,1.32,2.2), (-.85,1.22,-.6), 22),
        ("close_f", (.85,1.26,2.2), (.85,1.16,-.6), 22),
        ("profile", (3.5,1.2,-.5), (0,1.0,-.5), 30),
        ("talk_blink", (-.85,1.32,2.2), (-.85,1.22,-.6), 22),
        ("head_turn", (0,1.25,4.6), (0,1.1,-.6), 40),
    ]
    for name, eye, target, fov in shots:
        skip = selected and name not in selected
        if skip:
            continue
        talking = name == "talk_blink"
        lookup["AnchorM_Mouth"].hide_render = not talking
        lookup["AnchorM_Lids"].hide_render = not talking
        turning = name == "head_turn"
        if turning:
            for prefix, yaw in (("AnchorM_", 25), ("AnchorF_", -25)):
                joint = game_to_blender(lookup[prefix + "Body"]["head_joint"])
                rotation = Matrix.Translation(joint) @ Matrix.Rotation(math.radians(yaw), 4, "Z") @ Matrix.Translation(-joint)
                for suffix in ("Head", "Mouth", "Lids"):
                    obj = lookup[prefix + suffix]
                    obj.matrix_world = rotation @ obj.matrix_world
        render(camera, directory, name + ".png", eye, target, fov)
        if turning:
            for obj in objects:
                suffix = obj.name.split("_")[1]
                movable = suffix in ("Head", "Mouth", "Lids")
                if movable:
                    key = {"Head":"head_joint", "Mouth":"mouth_center", "Lids":"lids_center"}[suffix]
                    obj.matrix_world = Matrix.Translation(game_to_blender(lookup[obj.name.split("_")[0] + "_Body"][key]))


def main():
    started = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "packages/web/public/models/news-anchors.glb")
    parser.add_argument("--preview-dir", type=Path, default=PREVIEW_DIR)
    parser.add_argument("--skip-previews", action="store_true")
    parser.add_argument("--previews", nargs="*", choices=["two_shot", "close_m", "close_f", "profile", "talk_blink", "head_turn"])
    parser.add_argument("--samples", type=int, default=32, choices=[32,64])
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.preview_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    mats = create_materials()
    objects = Anchor(False).finish(mats) + Anchor(True).finish(mats)
    open_eye_rays = validate_open_eyes(objects)
    overlay_rays = validate_overlays(objects)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=str(args.output), export_format="GLB", use_selection=True,
                              export_yup=True, export_extras=True, export_texcoords=False,
                              export_normals=True, export_materials="EXPORT", export_attributes=False,
                              export_animations=False, export_cameras=False, export_lights=False,
                              export_skins=False, export_morph=False,
                              export_draco_mesh_compression_enable=False)
    nodes = validate_export(args.output, objects)
    geometry_seconds = time.monotonic() - started
    if not args.skip_previews:
        render_previews(objects, mats, args.preview_dir, args.samples, args.previews)
    stats = {"coordinate_system": "+Y up, +Z forward; metres; unparented translation-only nodes",
             "blender_version": bpy.app.version_string, "nodes": nodes,
             "triangles_per_anchor": {prefix: sum(v["triangles"] for k,v in nodes.items() if k.startswith(prefix)) for prefix in ("AnchorM_", "AnchorF_")},
             "total_triangles": sum(v["triangles"] for v in nodes.values()),
             "open_eye_material_rays_passed": open_eye_rays,
             "overlay_occlusion_rays_passed": overlay_rays,
             "glb_bytes": args.output.stat().st_size, "glb_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
             "geometry_export_seconds": round(geometry_seconds, 3), "generation_seconds": round(time.monotonic() - started, 3),
             "previews": [] if args.skip_previews else args.previews or ["two_shot", "close_m", "close_f", "profile", "talk_blink", "head_turn"],
             "validation": "8 unparented nodes; translation-only; unit normals; pivots match extras; triangle/file limits; no textures, bones, morphs, animations, cameras or lights"}
    payload = json.dumps(stats, indent=2, ensure_ascii=False)
    (args.preview_dir / "stats.json").write_text(payload + "\n")
    print(payload, flush=True)


if __name__ == "__main__":
    main()
