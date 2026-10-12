# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic paddock grooms: +X forward, +Y up, +Z right, 1 m = 1.5 units.

Run Blender -b --factory-startup -noaudio --python paddock_groom.py -- [options].
Each variant has four unparented, translation-only nodes. Extras are absolute
game-coordinate attachment positions. The lead itself belongs to the scene.
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


ROOT = Path(__file__).resolve().parents[4]
PREVIEW_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "paddock-groom"
COLORS = {
    "Skin": "ce997b", "HairM": "201c1b", "Brow": "342724",
    "Lips": "9e6359", "EyeWhite": "ece8dc", "Iris": "654333",
    "Pupil": "151b21", "GroomShirt": "f6f5ee", "GroomPants": "29354a",
    "GroomShoes": "20252b", "Helmet": "181e26", "Armband": "289653",
}
JOINTS = {
    "hip_left": (0, .905, -.095),
    "hip_right": (0, .905, .095),
    "shoulder_left": (0, 1.355, -.180),
    "lead_hand": (.335, 1.150, .290),
}


def game_to_blender(point):
    x, y, z = point
    return Vector((x, -z, y))


def blender_to_game(point):
    return (point[0], point[2], -point[1])


def srgb(value):
    return value / 12.92 if value <= .04045 else ((value + .055) / 1.055) ** 2.4


def material(name, color, roughness=.65):
    rgba = tuple(srgb(int(color[i:i + 2], 16) / 255) for i in (0, 2, 4)) + (1,)
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = rgba
    mat.use_nodes = True
    mat.use_backface_culling = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = rgba
    shader.inputs["Roughness"].default_value = roughness
    return mat


class Mesh:
    def __init__(self, name):
        self.name = name
        self.vertices = []
        self.faces = []
        self.materials = []

    def add(self, vertices, faces, mat):
        offset = len(self.vertices)
        self.vertices.extend(Vector(v) for v in vertices)
        self.faces.extend(tuple(offset + i for i in face) for face in faces)
        self.materials.extend([mat] * len(faces))

    def loft(self, rows, mat, sides=16):
        """Rows: (forward center, height, lateral center, depth, half-width)."""
        vertices = [(x + depth * math.cos(math.tau * i / sides), y,
                     z + width * math.sin(math.tau * i / sides))
                    for x, y, z, depth, width in rows for i in range(sides)]
        faces = []
        for row in range(len(rows) - 1):
            for i in range(sides):
                a, b = row * sides + i, row * sides + (i + 1) % sides
                faces.append((a, a + sides, b + sides, b))
        faces.extend([tuple(range(sides)), tuple(reversed(range(len(vertices) - sides, len(vertices))))])
        self.add(vertices, faces, mat)

    def ellipsoid(self, center, radii, mat, sides=16, bands=8):
        vertices = [(center[0], center[1] + radii[1], center[2])]
        for row in range(1, bands):
            phi = math.pi * row / bands
            for col in range(sides):
                theta = math.tau * col / sides
                vertices.append((center[0] + radii[0] * math.sin(phi) * math.cos(theta),
                                 center[1] + radii[1] * math.cos(phi),
                                 center[2] + radii[2] * math.sin(phi) * math.sin(theta)))
        vertices.append((center[0], center[1] - radii[1], center[2]))
        faces = []
        for col in range(sides):
            nxt = (col + 1) % sides
            faces.append((0, 1 + nxt, 1 + col))
            for row in range(bands - 2):
                a, b = 1 + row * sides + col, 1 + row * sides + nxt
                faces.append((a, b, b + sides, a + sides))
            a, b = 1 + (bands - 2) * sides + col, 1 + (bands - 2) * sides + nxt
            faces.append((len(vertices) - 1, a, b))
        self.add(vertices, faces, mat)

    def tube(self, points, widths, mat, sides=12, depth=1):
        vertices, faces = [], []
        previous = None
        for i, point in enumerate(points):
            tangent = Vector(points[min(i + 1, len(points) - 1)]) - Vector(points[max(0, i - 1)])
            tangent.normalize()
            reference = Vector((0, 0, 1))
            is_parallel = abs(tangent.dot(reference)) > .92
            if is_parallel:
                reference = Vector((1, 0, 0))
            u = tangent.cross(reference).normalized()
            has_previous = previous is not None
            if has_previous:
                transported = previous - tangent * previous.dot(tangent)
                is_stable = transported.length > .001
                if is_stable:
                    u = transported.normalized()
            previous = u
            v = tangent.cross(u).normalized()
            vertices.extend(Vector(point) + widths[i] * (u * math.cos(math.tau * j / sides)
                            + depth * v * math.sin(math.tau * j / sides)) for j in range(sides))
        for row in range(len(points) - 1):
            for j in range(sides):
                a, b = row * sides + j, row * sides + (j + 1) % sides
                faces.append((a, b, b + sides, a + sides))
        faces.extend([tuple(reversed(range(sides))), tuple(range(len(vertices) - sides, len(vertices)))])
        self.add(vertices, faces, mat)

    def panel(self, points, mat, thickness=.003):
        n = len(points)
        vertices = list(points) + [(x - thickness, y, z) for x, y, z in points]
        faces = [tuple(range(n)), tuple(reversed(range(n, n * 2)))]
        faces.extend((i, (i + 1) % n, (i + 1) % n + n, i + n) for i in range(n))
        self.add(vertices, faces, mat)

    def finish(self, mats, transform, joint=(0, 0, 0)):
        origin = transform(joint)
        mesh = bpy.data.meshes.new(self.name)
        mesh.from_pydata([game_to_blender(transform(v) - origin) for v in self.vertices], [], self.faces)
        mesh.update()
        names = list(dict.fromkeys(self.materials))
        for name in names:
            mesh.materials.append(mats[name])
        for poly, name in zip(mesh.polygons, self.materials):
            # Buried end caps must not bend the visible cloth/limb normals.
            poly.use_smooth = len(poly.vertices) <= 4
            poly.material_index = names.index(name)
        # Every detail is a closed solid, so outward normals remain unambiguous.
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
        assert all(edge.is_manifold for edge in bm.edges), self.name
        unseen = set(bm.faces)
        while unseen:
            seed = unseen.pop()
            component, queue = [seed], [seed]
            while queue:
                face = queue.pop()
                for edge in face.edges:
                    for neighbor in edge.link_faces:
                        is_new = neighbor in unseen
                        if is_new:
                            unseen.remove(neighbor)
                            component.append(neighbor)
                            queue.append(neighbor)
            volume = sum(face.verts[0].co.dot(face.verts[i].co.cross(face.verts[i + 1].co)) / 6
                         for face in component for i in range(1, len(face.verts) - 1))
            is_inward = volume < 0
            if is_inward:
                bmesh.ops.reverse_faces(bm, faces=component)
            assert abs(volume) > 1e-13, (self.name, volume)
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = game_to_blender(origin)
        return obj


def transform_for(female):
    height = 1.60 / 1.72 if female else 1
    width = .82 if female else 1
    depth = .88 if female else 1

    def transform(point):
        x, y, z = point
        is_head = y > 1.425
        head_mix = min(1, max(0, (y - 1.425) / .07))
        lateral = width + (.94 - width) * head_mix if female and is_head else width
        forward = depth + (.96 - depth) * head_mix if female and is_head else depth
        return Vector((x * forward * 1.5, y * height * 1.5, z * lateral * 1.5))
    return transform


def make_head(mesh, female):
    head_start = len(mesh.vertices)
    sections = [
        (1.420, .025, .028, .031), (1.433, .022, .047, .049),
        (1.455, .014, .064, .066), (1.482, .010, .076, .077),
        (1.510, .008, .084, .084), (1.540, .006, .087, .086),
        (1.570, .004, .085, .084), (1.600, .001, .085, .082),
        (1.631, -.003, .083, .081), (1.660, -.008, .074, .074),
        (1.687, -.011, .047, .048), (1.700, -.012, .010, .012),
    ]

    def section(y):
        for lower, upper in zip(sections, sections[1:]):
            contains = lower[0] <= y <= upper[0]
            if contains:
                t = (y - lower[0]) / (upper[0] - lower[0])
                return tuple(a * (1 - t) + b * t for a, b in zip(lower[1:], upper[1:]))
        return sections[-1][1:]

    def relief(y, z):
        def bump(cy, cz, wy, wz):
            return math.exp(-((y - cy) / wy) ** 2 - ((z - cz) / wz) ** 2)
        return (.020 * bump(1.548, 0, .034, .014)
                + .026 * bump(1.521, 0, .018, .019)
                + sum(.008 * bump(1.514, side * .015, .009, .009) for side in (-1, 1))
                + .004 * bump(1.484, 0, .020, .035)
                + .005 * bump(1.449, 0, .015, .030)
                + sum(.006 * bump(1.531, s * .047, .024, .025)
                      - .004 * bump(1.572, s * .037, .012, .022) for s in (-1, 1)))

    def surface(y, z, lift=0):
        cx, depth, width = section(y)
        return (cx + depth * max(.001, 1 - (z / width) ** 2) ** .38 + relief(y, z) + lift, y, z)

    vertices, faces = [], []
    # Spend the facial grid on the nose/cheeks instead of the covered scalp.
    heights = (1.420, 1.433, 1.446, 1.460, 1.476, 1.490, 1.503, 1.510,
               1.518, 1.527, 1.537, 1.548, 1.560, 1.566, 1.574, 1.581,
               1.589, 1.600, 1.608, 1.616, 1.687, 1.700)
    rows, sides = len(heights), 34
    for y in heights:
        cx, depth, width = section(y)
        for col in range(sides):
            is_front_sample = col <= 28
            theta = -math.pi / 2 + math.pi * col / 28 if is_front_sample else math.pi / 2 + math.pi * (col - 28) / 6
            cosine = math.cos(theta)
            z = width * math.sin(theta)
            x = cx + depth * math.copysign(abs(cosine) ** .76, cosine)
            is_front = cosine > 0
            if is_front:
                x += relief(y, z) * min(1, cosine * 3)
            vertices.append((x, y, z))
    for row in range(rows - 1):
        for col in range(sides):
            a, b = row * sides + col, row * sides + (col + 1) % sides
            faces.append((a, a + sides, b + sides, b))
    faces.extend([tuple(range(sides)), tuple(reversed(range(len(vertices) - sides, len(vertices))))])
    mesh.add(vertices, faces, "Skin")
    for side in (-1, 1):
        mesh.ellipsoid((.004, 1.548, side * .084), (.019, .030, .011), "Skin", 12, 8)
        mesh.ellipsoid((.020, 1.548, side * .087), (.0025, .014, .006), "Lips", 10, 6)
        ey, ez = 1.574, side * .037
        # The almond's rear cap is buried in the face, avoiding floating eyeballs.
        points = [surface(ey, ez, .006)]
        for i in range(16):
            angle = math.tau * i / 16
            points.append(surface(ey + .0072 * math.copysign(abs(math.sin(angle)) ** 1.4, math.sin(angle)),
                                  ez + .020 * math.cos(angle), .0018))
        points.append(surface(ey, ez, -.008))
        eye_faces = [(0, i + 1, (i + 1) % 16 + 1) for i in range(16)]
        eye_faces.extend((17, (i + 1) % 16 + 1, i + 1) for i in range(16))
        mesh.add(points, eye_faces, "EyeWhite")
        lid = [surface(ey + .0072 * max(0, 1 - (-1 + i / 3) ** 2) ** .7,
                       ez + .020 * (-1 + i / 3), .002) for i in range(7)]
        mesh.tube(lid, [.0012] * 7, "Skin", 6)
        mesh.ellipsoid(surface(ey, ez, .0055), (.0025, .0058, .0058), "Iris", 12, 6)
        mesh.ellipsoid(surface(ey, ez, .0075), (.0012, .0031, .0031), "Pupil", 10, 6)
        mesh.ellipsoid(surface(ey + .002, ez - .0013, .0085), (.0008, .0012, .0012), "EyeWhite", 8, 4)
        brow = [surface(1.596 + .005 * math.sin(math.pi * i / 6) - .002 * i / 6,
                        side * (.017 + .042 * i / 6), .0026) for i in range(7)]
        mesh.tube(brow, [.0013, .0024, .0029, .0028, .0025, .0018, .0008], "Brow", 6)
        mesh.ellipsoid(surface(1.506, side * .012, -.001), (.0015, .0010, .0024), "Lips", 8, 4)
        # Short temple hair and a fitted strap leave the ear silhouette legible.
        mesh.tube([(-.010, 1.639, side * .079), (.0, 1.608, side * .083),
                   (.004, 1.581, side * .083)], [.018, .015, .009], "HairM", 8, .35)
        mesh.tube([(.018, 1.632, side * .084), (.022, 1.578, side * .093),
                   (.004, 1.487, side * .067), (.034, 1.438, side * .022)],
                  [.0032] * 4, "Helmet", 6)
    for lower in (False, True):
        points = []
        for i in range(9):
            t = -1 + i / 4
            y = 1.481 + .002 * t * t + (-.002 if lower else .0015) * (1 - t * t)
            points.append(surface(y, t * .024, .0025))
        mesh.tube(points, [.0008 + .0015 * math.sin(math.pi * i / 8) for i in range(9)], "Lips", 6)
    has_ponytail = female
    if has_ponytail:
        mesh.ellipsoid((-.089, 1.579, 0), (.032, .036, .041), "HairM", 12, 8)
        mesh.tube([(-.103, 1.581, 0), (-.130, 1.548, 0), (-.142, 1.496, .009),
                   (-.129, 1.465, .018)], [.025, .027, .019, .005], "HairM", 12)
        mesh.tube([(-.106, 1.574, 0), (-.116, 1.562, 0)], [.026, .026], "Helmet", 10)
    for point in mesh.vertices[head_start:]:
        blend = min(1, max(0, (point.y - 1.36) / .060))
        point.y += (1.720 - point.y) * .13 * blend
    # Construct neck and helmet after the head proportion adjustment; otherwise
    # that adjustment stretches the neck and flattens the helmet dome again.
    neck_rows = []
    radius = .050 if female else .060
    for y, taper in ((1.350, 1.08), (1.390, 1.03), (1.436, 1), (1.477, .80)):
        depth, width = neck_radii(y, radius * taper, female)
        neck_rows.append((-.003, y, 0, depth, width))
    mesh.loft(neck_rows, "Skin", 16)
    make_helmet(mesh)


def neck_radii(y, radius, female):
    scale = transform_for(female)((1, y, 1)) / 1.5
    return radius / scale.x, radius / scale.z


def make_helmet(mesh):
    vertices, faces = [], []
    sides, rings = 32, 8
    for ring in range(rings):
        latitude = math.pi * ring / (2 * rings)
        for col in range(sides):
            theta = math.tau * col / sides
            vertices.append((-.011 + .107 * math.cos(latitude) * math.cos(theta),
                             1.619 + .101 * math.sin(latitude),
                             .098 * math.cos(latitude) * math.sin(theta)))
    vertices.append((-.011, 1.720, 0))
    for ring in range(rings - 1):
        for col in range(sides):
            a, b = ring * sides + col, ring * sides + (col + 1) % sides
            faces.append((a, a + sides, b + sides, b))
    for col in range(sides):
        faces.append(((rings - 1) * sides + col, len(vertices) - 1,
                      (rings - 1) * sides + (col + 1) % sides))
    faces.append(tuple(range(sides)))
    mesh.add(vertices, faces, "Helmet")
    mesh.ellipsoid((.055, 1.623, 0), (.088, .006, .088), "Helmet", 24, 6)


def make_collar(mesh, female):
    # A rounded, closed ribbon follows the neck; flat lapel plates leave gaps.
    vertices, faces = [], []
    samples, sides = 21, 8
    radius = .053 if female else .063
    for row in range(samples):
        theta = .38 + (math.tau - .76) * row / (samples - 1)
        end_distance = min(row, samples - 1 - row)
        end_blend = max(0, 1 - end_distance / 3)
        center_y = 1.418 - .021 * end_blend ** 2
        half_height = .018 - .007 * end_blend ** 2
        for col in range(sides):
            phi = math.tau * col / sides
            y = center_y + half_height * math.cos(phi)
            radial = radius + .003 * math.sin(phi) - .002 * math.cos(phi)
            depth, width = neck_radii(y, radial, female)
            vertices.append((-.003 + depth * math.cos(theta), y, width * math.sin(theta)))
    for row in range(samples - 1):
        for col in range(sides):
            a, b = row * sides + col, row * sides + (col + 1) % sides
            faces.append((a, b, b + sides, a + sides))
    faces.extend([tuple(range(sides)), tuple(reversed(range(len(vertices) - sides, len(vertices))))])
    mesh.add(vertices, faces, "GroomShirt")

    def front(y):
        rows = ((1.245, .121), (1.319, .098), (1.360, .071), (1.413, .061))
        for lower, upper in zip(rows, rows[1:]):
            contains = lower[0] <= y <= upper[0]
            if contains:
                t = (y - lower[0]) / (upper[0] - lower[0])
                return lower[1] * (1 - t) + upper[1] * t
        return rows[-1][1]

    mesh.loft([(front(y) + .001, y, 0, .0022, .010)
               for y in (1.270, 1.300, 1.319, 1.360, 1.398)], "GroomShirt", 8)
    for y in (1.295, 1.337, 1.379):
        mesh.ellipsoid((front(y) + .0035, y, 0), (.002, .0034, .0034), "GroomShirt", 8, 4)


def make_arm(mesh, right):
    side = 1 if right else -1
    sleeve = [(0, 1.334, side * .130), (.0, 1.344, side * .174),
              (.0, 1.321, side * .199), (.003, 1.291, side * .218),
              (.007, 1.265, side * .226), (.010, 1.249, side * .231),
              (.011, 1.245, side * .232), (.013, 1.232, side * .235)]
    sleeve_start = len(mesh.materials)
    mesh.tube(sleeve, [.046, .057, .061, .061, .059, .056, .057, .055], "GroomShirt", 16)
    is_left = not right
    if is_left:
        mesh.materials[sleeve_start + 3 * 16:sleeve_start + 4 * 16] = ["Armband"] * 16
    if right:
        mesh.tube([(.015, 1.252, .233), (.031, 1.183, .249), (.068, 1.112, .261),
                   (.101, 1.089, .269), (.153, 1.097, .277), (.235, 1.122, .285),
                   (.299, 1.144, .289), (.323, 1.150, .290)],
                  [.046, .045, .038, .036, .038, .033, .023, .027], "Skin", 14)
        mesh.ellipsoid(JOINTS["lead_hand"], (.039, .038, .029), "Skin", 14, 8)
        for i in range(4):
            x = .313 + i * .014
            mesh.tube([(x, 1.168, .304), (x, 1.159, .321), (x, 1.135, .319),
                       (x, 1.127, .300)], [.009, .010, .009, .0065], "Skin", 8)
        mesh.tube([(.312, 1.164, .273), (.333, 1.182, .284), (.352, 1.170, .301)],
                  [.012, .012, .009], "Skin", 8)
        return
    mesh.tube([(.013, 1.252, -.233), (.015, 1.174, -.243), (.019, 1.091, -.251),
               (.029, 1.019, -.254), (.032, .948, -.254), (.035, .897, -.253),
               (.038, .879, -.253)], [.045, .044, .035, .035, .029, .022, .024], "Skin", 14)
    mesh.ellipsoid((.041, .861, -.253), (.028, .054, .020), "Skin", 14, 8)
    for i in range(4):
        x = .019 + i * .013
        y = .826 + abs(i - 1.5) * .004
        mesh.tube([(x, .854, -.253), (x + .006, y, -.250), (x + .012, y - .009, -.239)],
                  [.0075, .007, .0045], "Skin", 8)
    mesh.tube([(.062, .883, -.243), (.077, .853, -.241), (.069, .837, -.235)],
              [.010, .009, .006], "Skin", 8)


def make_leg(mesh, side):
    z = side * .095
    mesh.loft([(.001, .106, z, .047, .043), (.001, .160, z, .050, .046),
               (.012, .300, z, .056, .050), (.027, .455, z, .061, .057),
               (.021, .523, z, .068, .064), (.007, .691, z, .083, .078),
               (-.004, .837, z, .091, .084), (-.003, .940, z, .086, .081)], "GroomPants", 18)
    # Creases are shallow cloth ridges; separate knee spheres look mechanical.
    mesh.tube([(.050, .170, z), (.069, .340, z), (.084, .457, z)],
              [.0012, .002, .0012], "GroomPants", 6)
    mesh.loft([(.047, 0, z, .112, .049), (.048, .014, z, .116, .053),
               (.048, .031, z, .115, .052), (.046, .037, z, .109, .049)], "GroomShoes", 18)
    mesh.loft([(.045, .032, z, .109, .048), (.041, .056, z, .105, .048),
               (.026, .078, z, .080, .043), (.008, .099, z, .052, .036),
               (.002, .125, z, .039, .034)], "GroomShoes", 18)
    for i in range(3):
        x = .031 + i * .015
        y = .092 - i * .007
        mesh.tube([(x, y - .006, z - .026), (x + .003, y, z), (x, y - .006, z + .026)],
                  [.002] * 3, "GroomShoes", 6)


def make_groom(prefix, female, mats):
    transform = transform_for(female)
    body = Mesh(prefix + "Body")
    body.loft([(-.005, .825, 0, .060, .149), (-.007, .880, 0, .085, .170),
               (-.002, .946, 0, .100, .171), (.0, .975, 0, .095, .163)], "GroomPants", 20)
    body.loft([(.0, .949, 0, .107, .174), (.0, .970, 0, .111, .175),
               (.002, 1.036, 0, .116, .172), (.004, 1.132, 0, .122, .178),
               (.005, 1.245, 0, .116, .189), (.001, 1.319, 0, .097, .194),
               (-.002, 1.360, 0, .073, .169), (.0, 1.413, 0, .061, .063)], "GroomShirt", 24)
    make_collar(body, female)
    make_head(body, female)
    make_arm(body, True)
    obj = body.finish(mats, transform)
    for name, point in JOINTS.items():
        obj[name] = [round(v, 6) for v in transform(point)]
    obj["height_m"] = 1.60 if female else 1.72
    obj["coordinate_system"] = "+X forward, +Y up, +Z right (horse side); 1 m = 1.5 units"
    objects = [obj]
    for suffix, side in (("LegL", -1), ("LegR", 1)):
        mesh = Mesh(prefix + suffix)
        make_leg(mesh, side)
        joint = JOINTS["hip_left" if side < 0 else "hip_right"]
        objects.append(mesh.finish(mats, transform, joint))
    arm = Mesh(prefix + "ArmL")
    make_arm(arm, False)
    objects.append(arm.finish(mats, transform, JOINTS["shoulder_left"]))
    return objects


def bounds(points):
    return {"min": [round(min(p[i] for p in points), 6) for i in range(3)],
            "max": [round(max(p[i] for p in points), 6) for i in range(3)]}


def accessor_values(doc, binary, index):
    acc = doc["accessors"][index]
    view = doc["bufferViews"][acc["bufferView"]]
    count = {"SCALAR": 1, "VEC3": 3}[acc["type"]]
    fmt = "<" + {5126: "f", 5125: "I", 5123: "H", 5121: "B"}[acc["componentType"]] * count
    stride = view.get("byteStride", struct.calcsize(fmt))
    offset = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return [struct.unpack_from(fmt, binary, offset + i * stride) for i in range(acc["count"])]


def validate_export(output, objects):
    data = output.read_bytes()
    assert struct.unpack_from("<4sII", data) == (b"glTF", 2, len(data))
    size, kind = struct.unpack_from("<I4s", data, 12)
    assert kind == b"JSON"
    doc = json.loads(data[20:20 + size])
    binary = data[28 + size:]
    assert len(doc["nodes"]) == 8
    assert {n["name"] for n in doc["nodes"]} == {o.name for o in objects}
    assert not any(doc.get(k) for k in ("animations", "skins", "cameras", "images", "textures", "extensionsRequired", "extensionsUsed"))
    assert {m["name"] for m in doc["materials"]} == set(COLORS)
    nodes = {}
    for node in doc["nodes"]:
        assert not any(k in node for k in ("rotation", "scale", "matrix", "children", "skin"))
        obj = next(o for o in objects if o.name == node["name"])
        translation = node.get("translation", [0, 0, 0])
        assert all(abs(a - b) < 1e-6 for a, b in zip(translation, blender_to_game(obj.location)))
        triangles, positions, mats = 0, [], []
        for prim in doc["meshes"][node["mesh"]]["primitives"]:
            assert prim.get("mode", 4) == 4 and not prim.get("targets") and not prim.get("extensions")
            positions.extend(accessor_values(doc, binary, prim["attributes"]["POSITION"]))
            normals = accessor_values(doc, binary, prim["attributes"]["NORMAL"])
            assert all(abs(sum(v * v for v in n) - 1) < .001 for n in normals)
            triangles += doc["accessors"][prim["indices"]]["count"] // 3
            mats.append(doc["materials"][prim["material"]]["name"])
        nodes[node["name"]] = {
            "triangles": triangles, "vertices": len(positions), "source_vertices": len(obj.data.vertices),
            "translation": translation, "bbox_local": bounds(positions),
            "bbox_world": bounds([tuple(p[i] + translation[i] for i in range(3)) for p in positions]),
            "materials": sorted(set(mats)), "extras": node.get("extras", {}),
        }
    for prefix, height in (("GroomA_", 2.58), ("GroomB_", 2.40)):
        members = [n for name, n in nodes.items() if name.startswith(prefix)]
        assert sum(n["triangles"] for n in members) <= 9000
        assert abs(max(n["bbox_world"]["max"][1] for n in members) - height) < 1e-5
        assert abs(min(n["bbox_world"]["min"][1] for n in members)) < 1e-5
        extras = nodes[prefix + "Body"]["extras"]
        assert extras["lead_hand"][0] > .3 and extras["lead_hand"][2] > .3
        for suffix, key in (("LegL", "hip_left"), ("LegR", "hip_right"), ("ArmL", "shoulder_left")):
            assert all(abs(a - b) < 1e-6 for a, b in zip(nodes[prefix + suffix]["translation"], extras[key]))
    assert len(data) <= 1_000_000
    return nodes


def setup_preview(samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.seed = 31
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("AfternoonSky")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (.69, .80, 1, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = .45
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=200)
    floor = bpy.context.object
    floor.name = "PreviewGround"
    floor.location.z = -.008
    floor.data.materials.append(material("PreviewGround", "a6afa0", .95))
    bpy.ops.object.light_add(type="SUN", location=game_to_blender((3, 6, -4)))
    sun = bpy.context.object
    sun.data.energy = 2.2
    sun.data.angle = math.radians(12)
    sun.data.color = (1, .88, .72)
    sun.rotation_euler = (game_to_blender((0, 0, 0)) - sun.location).to_track_quat("-Z", "Y").to_euler()
    bpy.ops.object.light_add(type="AREA", location=game_to_blender((4, 5, 5)))
    light = bpy.context.object
    light.data.energy = 220
    light.data.shape = "DISK"
    light.data.size = 5
    light.rotation_euler = (game_to_blender((0, 1, 0)) - light.location).to_track_quat("-Z", "Y").to_euler()
    # A wire box keeps the right hand visible from the horse-side camera.
    proxy_mat = material("PreviewHorseSize", "7d8b83", .8)
    proxy = Mesh("PreviewHorseSize_2.4x2.4x0.7")
    corners = [(x, y, z) for x in (-1.2, 1.2) for y in (0, 2.4) for z in (.55, 1.25)]
    for i, a in enumerate(corners):
        for b in corners[i + 1:]:
            edge = sum(abs(a[k] - b[k]) > .001 for k in range(3)) == 1
            if edge:
                proxy.tube([a, b], [.006, .006], proxy_mat.name, 6)
    proxy_obj = proxy.finish({proxy_mat.name: proxy_mat}, Vector)
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.lens_unit = "FOV"
    camera.data.sensor_fit = "HORIZONTAL"
    scene.camera = camera
    return camera, proxy_obj


def render_previews(objects, args):
    camera, proxy = setup_preview(args.samples)
    scene = bpy.context.scene
    groups = [objects[:4], objects[4:]]
    rest = {obj.name: obj.location.copy() for obj in objects}

    def place(group, x, phase=0, lift=0):
        for obj in group:
            original = obj.get("preview_source", obj.name)
            obj.location = rest[original] + game_to_blender((x, lift, 0))
            angle = 0
            is_left_leg = original.endswith("LegL")
            is_right_leg = original.endswith("LegR")
            is_left_arm = original.endswith("ArmL")
            if is_left_leg:
                angle = 25 * phase
            if is_right_leg:
                angle = -25 * phase
            if is_left_arm:
                angle = -20 * phase
            obj.rotation_euler = Matrix.Rotation(math.radians(angle), 4, game_to_blender((0, 0, 1))).to_euler()

    def render(name, eye, target, fov=35, size=(1400, 1000)):
        camera.location = game_to_blender(eye)
        camera.rotation_euler = (game_to_blender(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.angle = math.radians(fov)
        scene.render.resolution_x, scene.render.resolution_y = size
        scene.render.filepath = str(args.preview_dir / (name + ".png"))
        bpy.ops.render.render(write_still=True)

    place(groups[0], 2)
    place(groups[1], 0)
    proxy.location.x = 1
    render("side", (1, 1.8, -7), (1, 1.4, 0))
    place(groups[0], -.78)
    place(groups[1], .78)
    proxy.location.x = 0
    render("front34", (5, 2.2, 4), (0, 1.4, 0), size=(1400, 1200))
    proxy.hide_render = True
    # Reposition the pair laterally for a face comparison at the same distance.
    place(groups[0], 0)
    place(groups[1], 0, lift=.165)
    for obj in groups[0]:
        obj.location += game_to_blender((0, 0, -.30))
    for obj in groups[1]:
        obj.location += game_to_blender((0, 0, .30))
    render("face", (2.25, 2.43, .45), (.015, 2.36, 0), fov=29, size=(1500, 900))
    copies = []
    for group in groups:
        duplicate = []
        for obj in group:
            copy = obj.copy()
            copy["preview_source"] = obj.name
            bpy.context.collection.objects.link(copy)
            duplicate.append(copy)
        copies.append(duplicate)
    for index, group in enumerate(groups + copies):
        phase = 1 if index < 2 else -1
        place(group, 3.70 - index * 1.80, phase)
        bpy.context.view_layer.update()
        lowest = min((obj.matrix_world @ vert.co).z for obj in group for vert in obj.data.vertices)
        for obj in group:
            obj.location.z -= lowest
    render("walk", (1, 2.5, -12), (1, 1.36, 0), size=(1800, 850))


def main():
    started = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "packages/web/public/models/paddock-groom.glb")
    parser.add_argument("--preview-dir", type=Path, default=PREVIEW_DIR)
    parser.add_argument("--skip-previews", action="store_true")
    parser.add_argument("--samples", type=int, choices=[32, 64], default=32)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.preview_dir.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    mats = {name: material(name, color, .26 if name == "Helmet" else .65) for name, color in COLORS.items()}
    objects = make_groom("GroomA_", False, mats) + make_groom("GroomB_", True, mats)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=str(args.output), export_format="GLB", use_selection=True,
                             export_yup=True, export_extras=True, export_texcoords=False,
                             export_normals=True, export_materials="EXPORT", export_attributes=False,
                             export_animations=False, export_cameras=False, export_lights=False,
                             export_skins=False, export_morph=False, export_draco_mesh_compression_enable=False)
    nodes = validate_export(args.output, objects)
    geometry_seconds = time.monotonic() - started
    do_previews = not args.skip_previews
    if do_previews:
        render_previews(objects, args)
    stats = {
        "blender_version": bpy.app.version_string,
        "revision": "Claude review 1: shorter/wider visible neck, rounded standing polo collar and placket, stronger nose bridge/tip, hemispherical helmet",
        "model_measurements": {
            "neck_diameter_m": {"GroomA": .120, "GroomB": .100},
            "visible_neck_reduction_units": {"GroomA": .0375, "GroomB": round(.0375 * 1.60 / 1.72, 6)},
            "collar_height_m": {"GroomA": .036, "GroomB": round(.036 * 1.60 / 1.72, 6)},
            "neck_shortening_method": "Raise collar upper edge from 1.411 to 1.436 authored metres; retain head/eye height and all attachment pivots",
        },
        "coordinate_system": "+X forward; +Y up; +Z right / horse side; 1 m = 1.5 units",
        "nodes": nodes,
        "variants": {prefix: {"triangles": sum(n["triangles"] for name, n in nodes.items() if name.startswith(prefix)),
                               "height_m": height, "height_units": round(height * 1.5, 6)}
                     for prefix, height in (("GroomA_", 1.72), ("GroomB_", 1.60))},
        "total_triangles": sum(n["triangles"] for n in nodes.values()),
        "glb_bytes": args.output.stat().st_size,
        "glb_sha256": hashlib.sha256(args.output.read_bytes()).hexdigest(),
        "geometry_export_seconds": round(geometry_seconds, 3),
        "generation_seconds": round(time.monotonic() - started, 3),
        "previews": ["side.png", "front34.png", "walk.png", "face.png"] if do_previews else [],
        "preview_notes": [
            "side/front34 use the requested camera positions, targets, and 35 degree horizontal FOV.",
            "Horse proxy is a 2.4 long x 2.4 high x 0.7 wide wire box, centered 0.9 units toward +Z.",
            "walk left to right: A / B at phase +1, A / B at phase -1; legs +/-25, left arm -/+20 degrees about game Z.",
            "walk only: entire figures are lowered to meet the ground after rigid leg rotation.",
            "face only: B is raised 0.165 units for eye-level comparison.",
        ],
        "validation": "8 translation-only nodes; joint/extras agreement; exact heights; closed outward-facing solids; unit normals; 12 shared materials; <=9000 triangles/person; <=1 MB; no textures, animation, skins, morphs, cameras, lights, or compression",
    }
    payload = json.dumps(stats, ensure_ascii=False, indent=2)
    (args.preview_dir / "stats.json").write_text(payload + "\n")
    print(payload, flush=True)


if __name__ == "__main__":
    main()
