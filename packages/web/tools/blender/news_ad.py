# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic studio AD. Metres, +Y up, +Z forward; four movable meshes.

Run Blender -b --factory-startup -noaudio --python news_ad.py -- [options].
Face construction shares the presenters' anatomical loft / almond-eye approach.
All authoring is self-contained so concurrent presenter edits cannot change this GLB.
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

ROOT = Path(__file__).resolve().parents[4]
PREVIEW_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "news-ad"
TAU = math.tau
HEAD_JOINT = (0, 1.455, .095)
CARD_CENTER = (0, 1.32, .42)
CARD_ANGLE = math.radians(10)
PAGE_SIZE = (.40, .30)


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
    shader.inputs["Specular IOR Level"].default_value = .22 if roughness > .4 else .4
    return mat


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
                is_stable = transported.length > .001
                if is_stable:
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


class Face:
    def __init__(self):
        self.prefix = "AD_"
        self.x = 0
        self.dy = 0
        self.sx = 1
        self.hair = "HairM"
        self.head = Mesh(self.prefix + "Head")
        self.face_rows = [
            (1.178, .017, -.441, .043), (1.187, .039, -.437, .060),
            (1.203, .057, -.439, .069), (1.224, .068, -.442, .077),
            (1.250, .076, -.444, .081), (1.276, .081, -.446, .084),
            (1.300, .080, -.447, .082), (1.324, .078, -.448, .082),
            (1.350, .076, -.450, .083), (1.374, .067, -.454, .080),
            (1.395, .047, -.456, .062), (1.409, .013, -.456, .023),
        ]

    def p(self, x, y, z):
        return (self.x + x * self.sx, y + self.dy, z)

    def section(self, y):
        for index, (lower, upper) in enumerate(zip(self.face_rows, self.face_rows[1:])):
            within = lower[0] <= y <= upper[0]
            if within:
                span = upper[0] - lower[0]
                t = (y - lower[0]) / span
                previous = self.face_rows[max(0, index - 1)]
                following = self.face_rows[min(len(self.face_rows) - 1, index + 2)]
                values = []
                for i in (1, 2, 3):
                    slope_a = (upper[i] - previous[i]) / (upper[0] - previous[0])
                    slope_b = (following[i] - lower[i]) / (following[0] - lower[0])
                    values.append((2*t**3-3*t*t+1)*lower[i] + (t**3-2*t*t+t)*span*slope_a
                                  + (-2*t**3+3*t*t)*upper[i] + (t**3-t*t)*span*slope_b)
                return tuple(values)
        return self.face_rows[-1][1:]

    def relief(self, x, y):
        def bump(cx, cy, wx, wy):
            return math.exp(-((x - cx) / wx) ** 2 - ((y - cy) / wy) ** 2)
        cheeks = sum(.0080 * bump(side * .046, 1.271, .025, .022) for side in (-1, 1))
        sockets = sum(-.0052 * bump(side * .0345, 1.301, .021, .012) for side in (-1, 1))
        brows = sum(.0025 * bump(side * .033, 1.320, .027, .009) for side in (-1, 1))
        muzzle = .0042 * bump(0, 1.235, .029, .019)
        chin = .0050 * bump(0, 1.197, .031, .013)
        bridge = .0110 * bump(0, 1.284, .014, .028)
        tip = .0220 * bump(0, 1.258, .014, .014)
        wings = sum(.0070 * bump(side * .012, 1.253, .006, .006) for side in (-1, 1))
        return cheeks + sockets + brows + muzzle + chin + bridge + tip + wings

    def face_z(self, x, y):
        rx, cz, rz = self.section(y)
        return cz + rz * max(.001, 1 - (x / rx) ** 2) ** .40 + self.relief(x, y)

    def face_p(self, x, y, lift=0):
        return self.p(x, y, self.face_z(x, y) + lift)

    def make_face(self):
        # A continuous skin surface avoids the sharp boundary of an attached nose patch.
        vertices, faces = [], []
        rings, segments = 42, 52
        for row in range(rings):
            y = mix(1.178, 1.409, row / (rings - 1))
            rx, cz, rz = self.section(y)
            for col in range(segments):
                # Most samples belong to the face; the back of the skull needs fewer.
                frontal = col <= 40
                theta = -math.pi / 2 + math.pi * col / 40 if frontal else math.pi / 2 + math.pi * (col - 40) / 12
                x = rx * math.sin(theta)
                cosine = math.cos(theta)
                z = cz + rz * math.copysign(abs(cosine) ** .8, cosine)
                is_front = cosine > 0
                if is_front:
                    z += self.relief(x, y) * min(1, cosine * 3)
                vertices.append(self.p(x, y, z))
        for row in range(rings - 1):
            for col in range(segments):
                a, b = row * segments + col, row * segments + (col + 1) % segments
                faces.append((a, b, b + segments, a + segments))
        faces.extend([tuple(reversed(range(segments))), tuple(range(len(vertices) - segments, len(vertices)))])
        self.head.add(vertices, faces, "Skin")
        self.head.loft([(self.x, y + self.dy, z, rx * self.sx, rz) for y, z, rx, rz in
                        [(1.091, -.465, .036, .039), (1.125, -.462, .040, .043),
                         (1.185, -.456, .041, .042), (1.223, -.449, .044, .044)]], "Skin", 32)
        for side in (-1, 1):
            self.head.ellipsoid(self.p(side * .081, 1.264, -.451), (.015, .029, .018), "Skin", 20, 10)
            ear = [self.p(side * x, y, z) for x, y, z in
                   [(.083, 1.245, -.431), (.091, 1.255, -.431), (.092, 1.276, -.438), (.084, 1.282, -.436)]]
            path = curve(ear, 5)
            self.head.tube(path, [.0025] * len(path), "Skin", 8)
            self.head.ellipsoid(self.p(side * .084, 1.257, -.431), (.004, .008, .0025), "Lips", 12, 8)
            self.make_eye(side)
        for side in (-1, 1):
            self.head.ellipsoid(self.face_p(side * .0108, 1.249, .0005), (.0027, .0013, .0010), "Lips", 12, 6)
        self.make_lips()
        self.make_hair()

    def make_eye(self, side):
        ex, ey = side * .0345, 1.300
        w, h = (.0155, .0063)
        for target, mat, extra, width, height in [(self.head, "EyeWhite", .0012, w, h)]:
            verts = [self.face_p(ex, ey, extra + .0048)]
            faces = []
            for row in range(1, 6):
                r = row / 5
                for col in range(32):
                    theta = TAU * col / 32
                    u, v = math.cos(theta), math.sin(theta)
                    x = ex + width * r * u
                    y = ey + height * r * math.copysign(abs(v) ** 1.35, v) + side * .0006 * r * u
                    verts.append(self.face_p(x, y, extra + .0048 * (1 - r * r)))
            for col in range(32):
                nxt = (col + 1) % 32
                faces.append((0, 1 + col, 1 + nxt))
                for row in range(4):
                    a, b = 1 + row * 32 + col, 1 + row * 32 + nxt
                    faces.append((a, a + 32, b + 32, b))
            target.add(verts, faces, mat)
        # Circular irises sit within the almond, without protruding eyeball spheres.
        for mat, radius, lift in [("Iris", .0054, .0064), ("Pupil", .00265, .0071)]:
            vertices = [self.face_p(ex, ey, lift + .0003)]
            for j in range(32):
                theta = TAU * j / 32
                vertices.append(self.face_p(ex + radius * math.cos(theta), ey + radius * math.sin(theta), lift))
            self.head.add(vertices, [(0, j + 1, (j + 1) % 32 + 1) for j in range(32)], mat)
        for upper in (False, True):
            path = []
            for j in range(17):
                u = -1 + 2 * j / 16
                v = max(0, 1 - u * u) ** .675
                y = ey + (h if upper else -h) * v + side * .0006 * u
                path.append(self.face_p(ex + w * u, y, .0017))
            self.head.tube(path, [.00125 if upper else .00085] * len(path), "Skin", 6)
            if upper:
                self.head.tube(path, [.00060] * len(path), "Brow", 6)
        brow = []
        for j in range(21):
            t = j / 20
            x = side * (.017 + .034 * t)
            y = 1.319 + .0045 * math.sin(math.pi * t) - .0025 * t
            brow.append(self.face_p(x, y, .0027))
        widths = [.0009 + .0022 * math.sin(math.pi * (j + 1) / 23) ** .6 for j in range(21)]
        self.head.tube(brow, widths, "Brow", 6, .48)

    def make_lips(self):
        width = .024
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
        self.head.tube(line, [.00045] * len(line), "Brow", 6)

    def make_hair(self):
        # Broad shallow waves belong to one scalp surface instead of parallel raised tubes.
        segments, bands = 56, 18
        vertices, faces = [], []
        def scalp_point(theta, t):
            signed = (theta + math.pi) % TAU - math.pi
            front = max(0, math.cos(theta))
            part = math.exp(-((signed - .35) / .32) ** 2)
            sweep = math.exp(-((signed + .60) / .55) ** 2)
            edge = 1.98 + .30 * max(0, -math.cos(theta)) - .85 * front ** .65 - .12 * part + .05 * sweep
            phi = .022 + t * edge
            flow = theta + .22 * math.sin(phi) * front
            y = 1.302 + .119 * math.cos(phi)
            wave = .0012 * math.sin(theta * 5 + phi * 1.4 + .55 * math.sin(theta * 2))
            for center_theta, center_phi, amplitude, spread in [
                (-.65,.74,.0055,.48), (.42,.61,.0045,.43),
                (-1.55,1.18,.0040,.58), (1.45,1.02,.0042,.52),
                (2.65,1.45,.0034,.62), (-2.65,.86,.0038,.55),
            ]:
                delta = (theta - center_theta + math.pi) % TAU - math.pi
                wave += amplitude * math.exp(-(delta/spread)**2 - ((phi-center_phi)/.45)**2)
            # Integrate tapered locks into the scalp so their edges cannot intersect it.
            for begin, end, start_t, end_t, half_width in [
                (-.45,-.90,.12,.95,.25), (.20,-.10,.10,.78,.28),
                (.70,.55,.20,.92,.23), (-1.2,-1.6,.25,.90,.23), (2.3,2.65,.28,.86,.26),
            ]:
                along = (t-start_t)/(end_t-start_t)
                inside_lock = 0 < along < 1
                if inside_lock:
                    center = mix(begin,end,along) + .07*math.sin(math.pi*along)
                    width = .008 + half_width*math.sin(math.pi*along)**.55
                    delta = (theta-center+math.pi)%TAU-math.pi
                    wave += .0032*math.sin(math.pi*along)**.8*math.exp(-(delta/width)**4)
            cosine = math.cos(flow)
            x = (.090 + wave) * math.sin(phi) * math.sin(flow)
            z = -.455 + (.101 + wave) * math.sin(phi) * cosine
            inside_skull_height = self.face_rows[0][0] <= y <= self.face_rows[-1][0]
            if inside_skull_height:
                rx, cz, rz = self.section(y)
                x = math.copysign(max(abs(x), (rx + .005 + wave) * abs(math.sin(flow))), x)
                skin_depth = (rz + .005 + wave) * abs(cosine)**.8
                is_front = cosine >= 0
                z = max(z, cz + skin_depth + self.relief(x, y)) if is_front else min(z, cz - skin_depth)
            return Vector(self.p(x, y, z))

        for row in range(bands + 1):
            for j in range(segments):
                vertices.append(scalp_point(TAU * j / segments, row / bands))
        for row in range(bands):
            for j in range(segments):
                a, b = row * segments + j, row * segments + (j + 1) % segments
                faces.append((a, a + segments, b + segments, b))
        faces.append(tuple(reversed(range(segments))))
        self.head.add(vertices, faces, self.hair)
        for side in (-1, 1):
            self.head.ellipsoid(self.p(side * .0805, 1.296, -.448), (.0055, .020, .010), self.hair, 16, 6)


def create_materials():
    specs = {
        'Skin': ('d9a183', .62), 'HairM': ('141210', .72),
        'Brow': ('35231e', .7), 'Lips': ('a96059', .58),
        'EyeWhite': ('eee8df', .3), 'Iris': ('50352b', .48), 'Pupil': ('120e0c', .52),
        'StaffShirt': ('171b23', .88), 'StaffPants': ('515a4b', .88),
        'Sneakers': ('c9c8bd', .72), 'Headset': ('222630', .42),
        'Radio': ('30353a', .6), 'Tape': ('b18c5c', .83),
        'Lanyard': ('467e98', .72), 'PassCard': ('f0ece1', .5),
        'CueCover': ('c4a44f', .78), 'CueSpiral': ('9ba4aa', .28, .8),
        'CuePaper': ('f1eee5', .86), 'CuePage': ('fffdf7', .9),
    }
    return {name: material(name, *spec) for name, spec in specs.items()}


def box(mesh, center, dimensions, mat, transform=None):
    verts = [Vector(center) + Vector((x * dimensions[0] / 2, y * dimensions[1] / 2, z * dimensions[2] / 2))
             for x, y, z in [(-1,-1,-1),(1,-1,-1),(1,1,-1),(-1,1,-1),(-1,-1,1),(1,-1,1),(1,1,1),(-1,1,1)]]
    has_transform = transform is not None
    if has_transform:
        verts = [transform(v) for v in verts]
    mesh.add(verts, [(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)], mat, False)


def path(mesh, points, radius, mat, sides=8, steps=5, depth=1):
    points = curve(points, steps)
    mesh.tube(points, [radius] * len(points), mat, sides, depth)


def card_point(point):
    x, y, depth = point
    z = depth - .0015
    c, s = math.cos(CARD_ANGLE), math.sin(CARD_ANGLE)
    return Vector(CARD_CENTER) + Vector((x, c * y + s * z, -s * y + c * z))


def torso_point(point):
    x, y, z = point
    weight = min(1, max(0, (1.42 - y) / .54))
    return Vector((x - .040 * weight, y, z + .068 * weight))


def leg_point(point, side):
    x, y, z = point
    weight = min(1, max(0, y / .86))
    is_relaxed = side > 0
    x -= .040 * weight
    z += .068 * weight
    if is_relaxed:
        bend = math.sin(math.pi * min(1, max(0, (y - .10) / .78)))
        x += .025 * (1 - weight)
        z += .055 * bend - .045 * (1 - weight)
        y -= .012 * weight
    else:
        x -= .006 * (1 - weight)
    return Vector((x, y, z))


def make_body(mats):
    body = Mesh('AD_Body')
    # A continuous shirt silhouette avoids ball-jointed shoulders and waist seams.
    rows = [(0,.87,-.020,.152,.108),(0,.91,-.015,.152,.108),
            (0,1.01,.005,.148,.105),(0,1.14,.040,.158,.107),
            (0,1.26,.069,.158,.104),(0,1.33,.080,.166,.092),
            (0,1.385,.087,.145,.071),(0,1.409,.090,.065,.046)]
    body.loft(rows, 'StaffShirt', 40, .8)
    body.loft([(0,1.382,.090,.041,.042),(0,1.44,.095,.043,.044),(0,1.483,.098,.041,.042)], 'Skin', 28)
    collar = [( .049 * math.sin(TAU*j/48), 1.401 + .008*math.cos(TAU*j/48), .09 + .047*math.cos(TAU*j/48)) for j in range(49)]
    body.tube(collar, [.005] * len(collar), 'StaffShirt', 8)
    body.loft([(0,.815,-.025,.141,.091),(0,.89,-.018,.153,.099),(0,.93,-.011,.149,.095)], 'StaffPants', 36)
    body.vertices = [torso_point(v) for v in body.vertices]
    for side in (-1,1):
        leg_start = len(body.vertices)
        x = side * .096
        body.loft([(x,.125,-.017,.046,.055),(x+side*.012,.20,-.024,.052,.060),
                   (x+side*.014,.35,-.024,.062,.067),(x+side*.009,.49,.012,.067,.075),
                   (x+side*.004,.56,.010,.073,.080),(x,.72,-.011,.087,.094),(x,.86,-.025,.087,.096)], 'StaffPants', 28)
        # Fabric pockets and creases remain part of the pants material for scene replacement.
        box(body,(side*.178,.69,.012),(.021,.148,.118),'StaffPants')
        box(body,(side*.185,.754,.012),(.022,.027,.125),'StaffPants')
        for y,z in [(.24,.034),(.48,.081),(.80,.067)]:
            path(body,[(x-.044,y-.010,z),(x,y,z+.004),(x+.047,y+.003,z-.005)],.002,'StaffPants',6,3)
        body.loft([(side*.112,.0,.063,.051,.121),(side*.112,.023,.063,.055,.125),
                   (side*.112,.039,.063,.055,.124)],'Sneakers',32)
        body.ellipsoid((side*.112,.062,.063),(.053,.044,.120),'Sneakers',28,12)
        body.loft([(side*.112,.052,-.009,.043,.046),(side*.112,.111,-.013,.042,.045)],'StaffShirt',24)
        for j in range(4):
            path(body,[(side*.112-.027,.094-j*.002,.028+j*.014),(side*.112,.102-j*.002,.030+j*.014),(side*.112+.027,.094-j*.002,.028+j*.014)],.0022,'PassCard',6,3)
        body.vertices[leg_start:] = [leg_point(v, side) for v in body.vertices[leg_start:]]
        shoulder = torso_point((side * .153, 1.329, .080))
        elbow = Vector((side * .234 - .010, 1.110, .226))
        wrist = card_point((side * .223, -.075, -.019))
        sleeve = [torso_point((side * .112, 1.334, .075)), shoulder,
                  torso_point((side * .183, 1.292, .111)), torso_point((side * .203, 1.250, .148))]
        body.tube(sleeve, [.040, .054, .055, .053], 'StaffShirt', 24)
        arm_points = curve([torso_point((side * .197, 1.264, .140)),
                            (side * .220 - .010, 1.19, .187), elbow,
                            (side * .230 - .005, 1.145, .291), wrist], 4)
        arm_widths = [.043, .044, .036, .034, .024]
        widths=[]
        for j in range(len(arm_points)):
            q=j/(len(arm_points)-1)*4
            k=min(3,int(q))
            widths.append(mix(arm_widths[k],arm_widths[k+1],q-k))
        body.tube(arm_points,widths,'Skin',24)
        # Palms support the board from behind; fingertips wrap only the 3 cm margin.
        palm=card_point((side*.218,-.039,-.014))
        body.ellipsoid(palm,(.033,.053,.025),'Skin',20,10)
        for j in range(4):
            y=-.080+j*.025
            points=[card_point((side*.231,y,-.028)),card_point((side*.208,y+.002,-.021)),
                    card_point((side*.198,y+.003,.004)),card_point((side*.182,y+.003,.010))]
            path(body,points,.0072 if j<3 else .0063,'Skin',8,4)
        path(body,[card_point((side*.238,-.023,-.008)),card_point((side*.229,.014,.0)),
                   card_point((side*.211,.037,.008)),card_point((side*.198,.039,.010))],.010,'Skin',10,5)
    accessory_start = len(body.vertices)
    # The lanyard lies on the forward-leaning shirt rather than hanging inside it.
    for side in (-1,1):
        path(body,[(side*.045,1.409,.111),(side*.085,1.335,.170),(side*.067,1.242,.159),(side*.018,1.179,.159)],.006,'Lanyard',8,5,.35)
    box(body,(0,1.14,.158),(.064,.094,.004),'PassCard')
    box(body,(0,1.172,.161),(.060,.018,.001),'Lanyard')
    box(body,(-.016,1.136,.161),(.019,.025,.001),'Lanyard')
    for j in range(3):
        box(body,(.013,1.145-j*.011,.161),(.026,.003,.001),'Headset')
    box(body,(0,1.191,.158),(.018,.011,.007),'CueSpiral')
    box(body,(-.161,.951,-.075),(.065,.107,.042),'Radio')
    box(body,(-.161,.969,-.098),(.043,.022,.004),'Headset')
    path(body,[(-.179,1.003,-.074),(-.186,1.065,-.075)],.004,'Radio',8,2)
    for x in (-.179,-.164,-.149):
        box(body,(x,1.006,-.077),(.008,.008,.012),'Headset')
    path(body,[(-.152,.985,-.052),(-.162,1.10,-.059),(-.145,1.26,-.047),(-.055,1.407,.068)],.0025,'Headset',8,8)
    # A rectangular annulus gives the tape roll its hollow cardboard core.
    cx,cy,cz=.188,.836,-.037
    verts=[]
    for z in (cz-.022,cz+.022):
        for r in (.028,.052):
            verts.extend((cx+r*math.cos(TAU*j/48),cy+r*math.sin(TAU*j/48),z) for j in range(48))
    faces=[]
    for j in range(48):
        k=(j+1)%48
        faces.extend([(j,k,48+k,48+j),(96+j,144+j,144+k,96+k),
                      (48+j,48+k,144+k,144+j),(j,96+j,96+k,k)])
    body.add(verts,faces,'Tape')
    path(body,[(.163,.927,-.033),(.191,.908,-.042),(.192,.874,-.040),(.169,.876,-.040)],.006,'StaffShirt',8,5)
    body.vertices[accessory_start:] = [torso_point(v) for v in body.vertices[accessory_start:]]
    obj=body.finish(mats,(0,0,0))
    obj['head_joint']=list(HEAD_JOINT)
    obj['standing_height_m']=1.70
    obj['coordinate_system']='+Y up, +Z forward; metres'
    return obj


def make_head(mats):
    face=Face()
    face.make_face()
    mesh=face.head
    mesh.name='AD_Head'
    mesh.vertices=[v+Vector((0,.279,.56)) for v in mesh.vertices]
    # The single-ear headband follows the skull crown; the other ear remains visible.
    points=[(.092*math.cos(math.pi*j/32),1.563+.129*math.sin(math.pi*j/32),.098) for j in range(33)]
    mesh.tube(points,[.006]*len(points),'Headset',8,1.65)
    mesh.ellipsoid((-.101,1.548,.103),(.020,.038,.029),'Headset',24,12)
    mesh.ellipsoid((-.118,1.548,.104),(.008,.026,.022),'Radio',20,10)
    path(mesh,[(-.111,1.535,.121),(-.110,1.514,.167),(-.075,1.502,.211),(-.035,1.500,.220)],.0032,'Headset',8,7)
    mesh.ellipsoid((-.029,1.500,.222),(.013,.006,.007),'Headset',16,8)
    obj=mesh.finish(mats,HEAD_JOINT)
    obj['yaw_range_degrees']=[-20,20]
    return obj


def make_card(mats):
    card=Mesh('AD_Card')
    box(card,(0,0,-.0075),(.406,.306,.003),'CueCover',card_point)
    box(card,(0,0,-.012),(.406,.306,.003),'CueCover',card_point)
    box(card,(0,0,-.0025),(.40,.30,.007),'CuePaper',card_point)
    for j in range(5):
        box(card,(0,-.1495,-.005+j*.0012),(.397,.0007,.00025),'CueCover',card_point)
    for j in range(14):
        cx=-.182+j*.028
        pts=[card_point((cx,.145+.013*math.sin(TAU*k/32),-.005+.014*math.cos(TAU*k/32))) for k in range(33)]
        card.tube(pts,[.0016]*len(pts),'CueSpiral',8)
    obj=card.finish(mats,CARD_CENTER)
    obj['page_size']=list(PAGE_SIZE)
    obj['page_normal']=[0,math.sin(CARD_ANGLE),math.cos(CARD_ANGLE)]
    page=Mesh('AD_CardPage')
    page.add([card_point((x,y,.0015)) for x,y in [(-.20,-.15),(.20,-.15),(.20,.15),(-.20,.15)]],[(0,1,2,3)],'CuePage',False)
    surface=page.finish(mats,CARD_CENTER)
    uv=surface.data.uv_layers.new(name='UVMap')
    # The exporter flips V; compensate so the GLB itself retains the requested
    # bottom-left (0,0), suitable for a default three.js CanvasTexture.
    coords=[(0,1),(1,1),(1,0),(0,0)]
    for poly in surface.data.polygons:
        for loop_index in poly.loop_indices:
            uv.data[loop_index].uv=coords[surface.data.loops[loop_index].vertex_index]
    surface['page_size']=list(PAGE_SIZE)
    surface['surface_offset_m']=.0005
    surface['uv_convention']='Exported TEXCOORD_0 viewed from +Z: lower-left (0,0), upper-right (1,1); CanvasTexture flipY=true'
    return obj,surface


def bounds(points):
    return {'min':[round(min(p[i] for p in points),6) for i in range(3)],
            'max':[round(max(p[i] for p in points),6) for i in range(3)]}


def accessor_values(doc,binary,index):
    acc=doc['accessors'][index]
    view=doc['bufferViews'][acc['bufferView']]
    n={'SCALAR':1,'VEC2':2,'VEC3':3}[acc['type']]
    fmt='<'+{5126:'f',5125:'I',5123:'H'}[acc['componentType']]*n
    stride=view.get('byteStride',struct.calcsize(fmt))
    offset=view.get('byteOffset',0)+acc.get('byteOffset',0)
    return [struct.unpack_from(fmt,binary,offset+i*stride) for i in range(acc['count'])]


def validate_export(output,objects):
    data=output.read_bytes()
    assert struct.unpack_from('<4sII',data)==(b'glTF',2,len(data))
    size,kind=struct.unpack_from('<I4s',data,12)
    assert kind==b'JSON'
    doc=json.loads(data[20:20+size])
    binary=data[28+size:]
    assert len(doc['nodes'])==4
    assert {n['name'] for n in doc['nodes']}=={o.name for o in objects}
    assert not any(doc.get(k) for k in ('animations','skins','cameras','images','textures','extensionsRequired'))
    stats={}
    for node in doc['nodes']:
        assert not any(k in node for k in ('rotation','scale','matrix','children','skin'))
        obj=next(o for o in objects if o.name==node['name'])
        translation=node.get('translation',[0,0,0])
        assert all(abs(a-b)<1e-6 for a,b in zip(translation,blender_to_game(obj.location)))
        positions,mats=[],[]
        triangles=0
        for prim in doc['meshes'][node['mesh']]['primitives']:
            assert prim.get('mode',4)==4 and not prim.get('targets')
            pos=accessor_values(doc,binary,prim['attributes']['POSITION'])
            positions.extend(pos)
            normals=accessor_values(doc,binary,prim['attributes']['NORMAL'])
            assert all(abs(sum(x*x for x in n)-1)<.001 for n in normals)
            triangles+=doc['accessors'][prim['indices']]['count']//3
            mats.append(doc['materials'][prim['material']]['name'])
            is_page=node['name']=='AD_CardPage'
            if is_page:
                uvs=accessor_values(doc,binary,prim['attributes']['TEXCOORD_0'])
                for p,uv in zip(pos,uvs):
                    assert abs(uv[0]-(p[0]/.4+.5))<1e-5
                    local_y=p[1]*math.cos(CARD_ANGLE)-p[2]*math.sin(CARD_ANGLE)
                    assert abs(uv[1]-(.5+local_y/.3))<1e-5
                assert all(n[2]>.98 and n[1]>.17 for n in normals)
                assert all(abs(sum(p[i] for p in pos) / len(pos)) < 1e-6 for i in range(3))
        stats[node['name']]={'triangles':triangles,'vertices':len(positions),'source_vertices':len(obj.data.vertices),
                            'translation':translation,'bbox_local':bounds(positions),
                            'bbox_world':bounds([tuple(p[i]+translation[i] for i in range(3)) for p in positions]),
                            'materials':sorted(set(mats)),'extras':node.get('extras',{})}
    assert stats['AD_Head']['triangles']<=14000,stats['AD_Head']['triangles']
    assert sum(n['triangles'] for n in stats.values())<=40000
    assert len(data)<=2_000_000
    assert set(m.name for o in objects for m in o.data.materials)==set(create_material_names())
    return stats


def create_material_names():
    return ['Skin','HairM','Brow','Lips','EyeWhite','Iris','Pupil','StaffShirt','StaffPants','Sneakers','Headset','Radio','Tape','Lanyard','PassCard','CueCover','CueSpiral','CuePaper','CuePage']


def marker_image():
    # Hand-authored brush strokes avoid an OS font dependency in the preview image.
    width,height=1024,768
    pixels=[1.0]*(width*height*4)
    def stroke(points,radius=6):
        for a,b in zip(points,points[1:]):
            distance=math.hypot(b[0]-a[0],b[1]-a[1])
            for k in range(max(2,int(distance*1.4))):
                t=k/max(1,int(distance*1.4)-1)
                x=a[0]+(b[0]-a[0])*t
                y=a[1]+(b[1]-a[1])*t
                r=radius*(.91+.09*math.sin(t*9))
                for py in range(max(0,int(y-r-1)),min(height,int(y+r+2))):
                    for px in range(max(0,int(x-r-1)),min(width,int(x+r+2))):
                        inside=(px-x)**2+(py-y)**2<=r*r
                        if inside:
                            i=((height-1-py)*width+px)*4
                            pixels[i:i+3]=[.015,.013,.010]
    stroke([(114,313),(152,284),(149,474)],9)
    stroke([(125,476),(176,476)],8)
    stroke([(230+49*math.cos(TAU*j/80),383+97*math.sin(TAU*j/80)) for j in range(81)],8)
    # 秒: 禾 + 少.
    for pts in [[(348,286),(310,307)],[(302,338),(387,334)],[(344,298),(340,488)],
                [(339,346),(315,396),(296,423)],[(348,373),(378,407)],
                [(440,292),(438,409)],[(412,324),(393,373)],[(469,323),(489,366)],
                [(478,383),(450,437),(395,482)]]:
        stroke(pts,7)
    # 前: grass-like top, 月 on the left, 刂 on the right.
    for pts in [[(577,282),(599,307)],[(689,280),(671,310)],[(555,326),(715,321)],
                [(581,356),(582,488)],[(584,355),(646,353),(646,482),(629,487)],
                [(586,396),(643,394)],[(585,434),(644,432)],
                [(678,357),(677,442)],[(710,348),(711,482),(685,492)]]:
        stroke(pts,7)
    # Center the entire handwritten phrase in the B4 page.
    image=bpy.data.images.new('PreviewMarker10Seconds',width=width,height=height)
    image.pixels.foreach_set(pixels)
    image.update()
    return image


def setup_preview(mats,samples):
    scene=bpy.context.scene
    scene.render.engine='CYCLES'
    scene.cycles.device='CPU'
    scene.cycles.samples=samples
    scene.cycles.use_denoising=True
    scene.cycles.seed=29
    scene.render.resolution_x=1200
    scene.render.resolution_y=1200
    scene.render.resolution_percentage=100
    scene.render.image_settings.file_format='PNG'
    scene.view_settings.view_transform='AgX'
    world=bpy.data.worlds.new('PreviewNavy')
    world.use_nodes=True
    world.node_tree.nodes['Background'].inputs['Color'].default_value=(.015,.024,.055,1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value=.35
    scene.world=world
    mats['PreviewFloor']=material('PreviewFloor','101a30',.9)
    floor=Mesh('PreviewFloor')
    box(floor,(0,-.027,0),(200,.05,200),'PreviewFloor')
    floor.finish(mats,(0,0,0))
    for name,position,power,size,tint in [('Key',(-2.3,3.4,2.3),460,3,(1,.89,.8)),
                                        ('Fill',(2.8,2.6,1.4),330,2.8,(.8,.88,1)),
                                        ('Rim',(.1,2.9,-2),560,2.2,(.76,.84,1))]:
        bpy.ops.object.light_add(type='AREA',location=game_to_blender(position))
        light=bpy.context.object
        light.name='Preview'+name
        light.data.energy=power
        light.data.shape='DISK'
        light.data.size=size
        light.data.color=tint
        light.rotation_euler=(game_to_blender((0,1,.1))-light.location).to_track_quat('-Z','Y').to_euler()
    bpy.ops.object.camera_add()
    camera=bpy.context.object
    camera.data.lens_unit='FOV'
    camera.data.sensor_fit='HORIZONTAL'
    scene.camera=camera
    preview=mats['CuePage'].copy()
    preview.name='PreviewCuePage'
    tex=preview.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image=marker_image()
    preview.node_tree.links.new(tex.outputs['Color'],preview.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    surface=bpy.data.objects['AD_CardPage']
    surface.data.materials[0]=preview
    # Blender's image coordinates differ from the deliberate exported UV contract.
    for loop in surface.data.uv_layers.active.data:
        loop.uv.y=1-loop.uv.y
    return camera


SHOTS=[('front',(0,1.35,3.2),(0,1.1,0),35),
       ('card_close',(.15,1.4,1.5),(0,1.3,.4),30),
       ('side',(3,1,.1),(0,.9,.1),35),
       ('back34',(-1.8,1.6,-2.2),(0,1.1,.2),40),
       ('head_turn',(0,1.35,3.2),(0,1.1,0),35),
       ('front_full',(0,1.35,3.2),(0,.91,0),35),
       ('head_close',(.42,1.67,1.35),(0,1.56,.10),22)]


def render_previews(mats,args):
    camera=setup_preview(mats,args.samples)
    head=bpy.data.objects['AD_Head']
    for name,eye,target,fov in SHOTS:
        skip=args.previews and name not in args.previews
        if skip:
            continue
        head.rotation_euler.z=math.radians(20) if name=='head_turn' else 0
        camera.location=game_to_blender(eye)
        camera.rotation_euler=(game_to_blender(target)-camera.location).to_track_quat('-Z','Y').to_euler()
        camera.data.angle=math.radians(fov)
        bpy.context.scene.render.filepath=str(args.preview_dir/(name+'.png'))
        bpy.ops.render.render(write_still=True)
    head.rotation_euler.z=0


def main():
    started=time.monotonic()
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=ROOT/'packages/web/public/models/news-ad.glb')
    parser.add_argument('--preview-dir',type=Path,default=PREVIEW_DIR)
    parser.add_argument('--skip-previews',action='store_true')
    parser.add_argument('--previews',nargs='*',choices=[s[0] for s in SHOTS])
    parser.add_argument('--samples',type=int,choices=[32,64],default=32)
    args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.preview_dir.mkdir(parents=True,exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    mats=create_materials()
    objects=[make_body(mats),make_head(mats),*make_card(mats)]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]
    bpy.ops.export_scene.gltf(filepath=str(args.output),export_format='GLB',use_selection=True,
                             export_yup=True,export_extras=True,export_texcoords=True,export_normals=True,
                             export_materials='EXPORT',export_attributes=False,export_animations=False,
                             export_cameras=False,export_lights=False,export_skins=False,export_morph=False,
                             export_draco_mesh_compression_enable=False)
    nodes=validate_export(args.output,objects)
    geometry_seconds=time.monotonic()-started
    do_preview=not args.skip_previews
    if do_preview:
        render_previews(mats,args)
    stats={'coordinate_system':'+Y up; +Z forward; metres; translation-only unparented nodes',
           'blender_version':bpy.app.version_string,'nodes':nodes,
           'revision':'Claude review 1: slender arms, continuous sculpted face, broad shallow hair clumps, left-leg support with relaxed right knee',
           'model_measurements':{'upper_arm_max_diameter_m':.088,'forearm_diameter_m':.068,'sleeve_diameter_m':.106,'back_lean_degrees':7.9,'support_leg':'left','pelvis_shift_x_m':-.040},
           'total_triangles':sum(n['triangles'] for n in nodes.values()),
           'glb_bytes':args.output.stat().st_size,'glb_sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),
           'geometry_export_seconds':round(geometry_seconds,3),'generation_seconds':round(time.monotonic()-started,3),
           'previews':(args.previews or [s[0] for s in SHOTS]) if do_preview else [],
           'preview_notes':[
               'front / head_turn use the exact requested camera; toes fall outside its frame.',
               'front_full is an additional full-body view with the target lowered to y=0.91 m.',
               'card_close uses the exact requested camera and crops the crown.',
           ],
           'validation':'4 nodes; translation-only; correct pivots; page winding / normal / UV; unit normals; all 19 materials; polygon and size limits; no images, skins, morphs, animation, cameras or lights'}
    payload=json.dumps(stats,ensure_ascii=False,indent=2)
    (args.preview_dir/'stats.json').write_text(payload+'\n')
    print(payload,flush=True)


if __name__=='__main__':
    main()
