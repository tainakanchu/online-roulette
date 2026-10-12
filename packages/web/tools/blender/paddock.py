# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic paddock in game coordinates: X long axis, Y up, -Z spectator side.

Blender -b --factory-startup -noaudio --python paddock.py -- [--skip-previews]
The exported track is the exact stadium ring, independent of the arrival path.
All preview props, lettering, lights and cameras are created AFTER GLB export.
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


PREVIEW_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "paddock"
OUTPUT = Path(__file__).resolve().parents[2] / "public/models/paddock.glb"
HALF = 27.0
RADIUS = 18.0
ARC_SEGMENTS = 96
EXTRAS = {
    "track": {"straight_half": HALF, "radius": RADIUS, "width": 6.0},
    "terraces": {"start_offset": 6.0, "steps": 4, "step_depth": 2.0, "step_rise": 0.45},
    "exit": {"x": -62.0, "width": 6.0},
    "entrance": {"x": 22.0, "z_end": 45.0, "width": 5.0},
}
PALETTE = {
    "PaddockTrack": (0.34, 0.105, 0.064), "PaddockLawn": (0.105, 0.26, 0.042),
    "Hedge": (0.035, 0.135, 0.034), "FlowerBed": (1, 1, 1),
    "Soil": (0.095, 0.046, 0.022), "RailWhite": (0.88, 0.90, 0.87),
    "Concrete": (0.48, 0.47, 0.43), "ConcreteDark": (0.075, 0.083, 0.076),
    "Roof": (0.085, 0.15, 0.135), "RoofSteel": (0.13, 0.18, 0.17),
    "BoardFrame": (0.032, 0.048, 0.048), "Screen": (0.012, 0.026, 0.025),
    "Glass": (0.19, 0.37, 0.42), "BuildingWall": (0.71, 0.66, 0.53),
    "Sign": (0.023, 0.13, 0.09), "Curb": (0.69, 0.68, 0.60),
}
BUILD_STATS = {}
LAWN_ISLANDS = (
    (-73, -61, -43, -7), (-59, 28, -43, -35),
    (31, 73, -43, -24), (51, 73, -21, -11),
    (59, 73, -8, 21), (31, 73, 24, 43),
    (-73, -18, 34, 43), (-73, -61, 7, 31),
)


def native(point):
    return Vector((point[0], -point[2], point[1]))


def material(name, rgb):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    mat.use_backface_culling = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*rgb, 1)
    shader.inputs["Roughness"].default_value = 0.78
    is_metal = name in ("RailWhite", "RoofSteel", "BoardFrame", "Roof")
    if is_metal:
        shader.inputs["Roughness"].default_value = 0.36
        shader.inputs["Metallic"].default_value = 0.35
    is_glass = name == "Glass"
    if is_glass:
        shader.inputs["Roughness"].default_value = 0.16
        shader.inputs["Transmission Weight"].default_value = 0.38
        shader.inputs["IOR"].default_value = 1.45
    is_flower = name == "FlowerBed"
    if is_flower:
        color = mat.node_tree.nodes.new("ShaderNodeVertexColor")
        color.layer_name = "COLOR_0"
        mat.node_tree.links.new(color.outputs["Color"], shader.inputs["Base Color"])
    return mat


class Mesh:
    def __init__(self, name, mat):
        self.name, self.mat = name, mat
        self.vertices, self.faces, self.smooth, self.colors = [], [], [], []
        self.origin = (0, 0, 0)
        self.uv = False

    def add(self, vertices, faces, smooth=False, color=(1, 1, 1, 1)):
        offset = len(self.vertices)
        self.vertices.extend(tuple(v) for v in vertices)
        self.faces.extend(tuple(offset + i for i in face) for face in faces)
        self.smooth.extend([smooth] * len(faces))
        self.colors.extend([color] * len(vertices))

    def surface(self, vertices):
        face = tuple(range(len(vertices)))
        a, b, c = (Vector(p) for p in vertices[:3])
        is_down = (b - a).cross(c - a).y < 0
        self.add(vertices, [tuple(reversed(face)) if is_down else face])

    def slab(self, x0, x1, z0, z1, y):
        self.surface([(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)])

    def box(self, center, size):
        x, y, z = center
        a, b, c = (v / 2 for v in size)
        vertices = [(x-a, y-b, z-c), (x+a, y-b, z-c), (x+a, y+b, z-c), (x-a, y+b, z-c),
                    (x-a, y-b, z+c), (x+a, y-b, z+c), (x+a, y+b, z+c), (x-a, y+b, z+c)]
        self.add(vertices, [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                            (3, 7, 6, 2), (0, 4, 7, 3), (1, 2, 6, 5)])

    def pipe(self, path, radius, sides=8):
        points = [Vector(p) for p in path]
        vertices = []
        for i, p in enumerate(points):
            tangent = (points[min(i+1, len(points)-1)] - points[max(i-1, 0)]).normalized()
            is_vertical = abs(tangent.y) > 0.95
            reference = Vector((1, 0, 0)) if is_vertical else Vector((0, 1, 0))
            u = tangent.cross(reference).normalized()
            v = tangent.cross(u)
            vertices.extend(p + radius * (u * math.cos(j*math.tau/sides) + v * math.sin(j*math.tau/sides)) for j in range(sides))
        faces = [(i*sides+j, i*sides+(j+1)%sides, (i+1)*sides+(j+1)%sides, (i+1)*sides+j)
                 for i in range(len(points)-1) for j in range(sides)]
        self.add(vertices, faces, smooth=True)
        self.add(vertices[:sides], [tuple(reversed(range(sides)))])
        self.add(vertices[-sides:], [tuple(range(sides))])

    def flower(self, center, diameter, color):
        x, y, z = center
        vertices = []
        for radius, height in ((diameter/2, -0.025), (diameter*0.36, 0.045)):
            vertices.extend((x+radius*math.cos(k*math.tau/6), y+height,
                             z+radius*math.sin(k*math.tau/6)) for k in range(6))
        vertices.append((x, y+0.070, z))
        faces = [(k, 6+k, 6+(k+1)%6, (k+1)%6) for k in range(6)]
        faces.extend((12, 6+(k+1)%6, 6+k) for k in range(6))
        self.add(vertices, faces, smooth=True, color=color)

    def shrub(self, center, radii):
        golden = (1+math.sqrt(5))/2
        unit = [(-1, golden, 0), (1, golden, 0), (-1, -golden, 0), (1, -golden, 0),
                (0, -1, golden), (0, 1, golden), (0, -1, -golden), (0, 1, -golden),
                (golden, 0, -1), (golden, 0, 1), (-golden, 0, -1), (-golden, 0, 1)]
        vertices = [tuple(center[j]+Vector(v).normalized()[j]*radii[j] for j in range(3)) for v in unit]
        faces = [(0,11,5), (0,5,1), (0,1,7), (0,7,10), (0,10,11),
                 (1,5,9), (5,11,4), (11,10,2), (10,7,6), (7,1,8),
                 (3,9,4), (3,4,2), (3,2,6), (3,6,8), (3,8,9),
                 (4,9,5), (2,4,11), (6,2,10), (8,6,7), (9,8,1)]
        self.add(vertices, faces, smooth=True)

    def finish(self, materials):
        mesh = bpy.data.meshes.new(self.name)
        center = Vector(self.origin)
        mesh.from_pydata([native(Vector(p)-center) for p in self.vertices], [], self.faces)
        mesh.materials.append(materials[self.mat])
        for face, smooth in zip(mesh.polygons, self.smooth):
            face.use_smooth = smooth
        is_flower = self.mat == "FlowerBed"
        if is_flower:
            color = mesh.color_attributes.new(name="COLOR_0", type="BYTE_COLOR", domain="POINT")
            for entry, rgba in zip(color.data, self.colors):
                entry.color = rgba
        has_uv = self.uv
        if has_uv:
            layer = mesh.uv_layers.new(name="UVMap")
            # The exporter flips V; preflip so the GLB itself has bottom-left (0, 0).
            for loop, uv in zip(layer.data, ((0, 1), (1, 1), (1, 0), (0, 0))):
                loop.uv = uv
        mesh.update()
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.collection.objects.link(obj)
        obj.location = native(self.origin)
        return obj


def line(x0, z0, x1, z1, count=1):
    return [(x0+(x1-x0)*i/count, z0+(z1-z0)*i/count) for i in range(count+1)]


def arc(cx, radius, a, b, count=ARC_SEGMENTS):
    return [(cx+radius*math.cos(a+(b-a)*i/count), radius*math.sin(a+(b-a)*i/count)) for i in range(count+1)]


def outline(radius):
    return (line(-HALF, -radius, HALF, -radius, 36)[:-1]
            + arc(HALF, radius, -math.pi/2, math.pi/2)[:-1]
            + line(HALF, radius, -HALF, radius, 36)[:-1]
            + arc(-HALF, radius, math.pi/2, 3*math.pi/2)[:-1])


def rounded_rectangle(rect, inset=0):
    x0, x1, z0, z1 = rect
    radius = 2-inset
    corners = ((x1-2, z0+2, -math.pi/2), (x1-2, z1-2, 0),
               (x0+2, z1-2, math.pi/2), (x0+2, z0+2, math.pi))
    return [(x+radius*math.cos(start+j*math.pi/16), z+radius*math.sin(start+j*math.pi/16))
            for x, z, start in corners for j in range(9)]


def point_on_ring(radius, station):
    circumference = 108+math.tau*radius
    s = station % circumference
    on_front = s < 54
    on_right = s < 54+math.pi*radius
    on_back = s < 108+math.pi*radius
    if on_front:
        return -27+s, -radius
    if on_right:
        angle = -math.pi/2+(s-54)/radius
        return 27+radius*math.cos(angle), radius*math.sin(angle)
    if on_back:
        return 27-(s-54-math.pi*radius), radius
    angle = math.pi/2+(s-108-math.pi*radius)/radius
    return -27+radius*math.cos(angle), radius*math.sin(angle)


def strip(mesh, inner, outer, y, bottom=None):
    for i in range(len(inner)-1):
        a, b = inner[i:i+2]
        c, d = outer[i:i+2]
        mesh.surface([(a[0], y, a[1]), (b[0], y, b[1]), (d[0], y, d[1]), (c[0], y, c[1])])
    has_sides = bottom is not None
    if not has_sides:
        return
    # The top follows a clockwise boundary in Y-up coordinates; side winding is explicit.
    for points, reverse in ((inner, False), (outer, True)):
        for a, b in zip(points, points[1:]):
            verts = [(a[0], bottom, a[1]), (b[0], bottom, b[1]), (b[0], y, b[1]), (a[0], y, a[1])]
            mesh.add(verts, [(3, 2, 1, 0) if reverse else (0, 1, 2, 3)])
    for index, reverse in ((0, True), (-1, False)):
        a, b = inner[index], outer[index]
        verts = [(a[0], bottom, a[1]), (b[0], bottom, b[1]), (b[0], y, b[1]), (a[0], y, a[1])]
        mesh.add(verts, [(3, 2, 1, 0) if reverse else (0, 1, 2, 3)])


def ring(mesh, r0, r1, y, bottom=None, gap=False):
    inner, outer = outline(r0), outline(r1)
    inner.append(inner[0])
    outer.append(outer[0])
    if not gap:
        strip(mesh, inner, outer, y, bottom)
        return
    # Exact four-unit opening, rather than deleting approximate tessellation segments.
    sections = [lambda r: line(-27, -r, 27, -r, 36),
                lambda r: arc(27, r, -math.pi/2, math.pi/2),
                lambda r: line(27, r, 2, r, 20),
                lambda r: line(-2, r, -27, r, 20),
                lambda r: arc(-27, r, math.pi/2, 3*math.pi/2)]
    for section in sections:
        strip(mesh, section(r0), section(r1), y, bottom)


def railing(mesh, path, levels=(0.9, 1.6), base=0.02, spacing=2.4, radius=0.065):
    for height in levels:
        mesh.pipe([(x, base+height, z) for x, z in path], radius)
    cumulative = [0.0]
    for a, b in zip(path, path[1:]):
        cumulative.append(cumulative[-1]+math.dist(a, b))
    stations = [i*spacing for i in range(math.floor(cumulative[-1]/spacing)+1)]
    needs_end_post = cumulative[-1]-stations[-1] > 0.35
    if needs_end_post:
        stations.append(cumulative[-1])
    segment = 0
    for station in stations:
        while segment < len(path)-2 and cumulative[segment+1] < station:
            segment += 1
        t = (station-cumulative[segment])/(cumulative[segment+1]-cumulative[segment])
        x, z = (path[segment][j]*(1-t)+path[segment+1][j]*t for j in range(2))
        mesh.pipe([(x, base, z), (x, base+max(levels), z)], radius*1.13)


def panel(name, mat, center, right, width, height):
    mesh = Mesh(name, mat)
    mesh.origin = center
    c, u, v = Vector(center), Vector(right)*width/2, Vector((0, height/2, 0))
    mesh.add([c-u-v, c+u-v, c+u+v, c-u+v], [(0, 1, 2, 3)])
    mesh.uv = True
    return mesh


def build():
    meshes = {name: Mesh("Paddock_"+name, name) for name in PALETTE if name not in ("Screen", "Sign")}
    concrete, rail = meshes["Concrete"], meshes["RailWhite"]
    # Continuous ground is required by the host scene; the exit never goes below it.
    concrete.slab(-75, 75, -45, 45, 0)
    island_area = 0
    for rect in LAWN_ISLANDS:
        outer, inner = rounded_rectangle(rect), rounded_rectangle(rect, 0.18)
        center = ((rect[0]+rect[1])/2, 0.035, (rect[2]+rect[3])/2)
        for i, a in enumerate(inner):
            b = inner[(i+1)%len(inner)]
            meshes["PaddockLawn"].surface([center, (a[0], 0.035, a[1]), (b[0], 0.035, b[1])])
        island_area += abs(sum(a[0]*b[1]-b[0]*a[1] for a, b in zip(outer, outer[1:]+outer[:1])))/2
        strip(meshes["Curb"], inner+[inner[0]], outer+[outer[0]], 0.14, 0)
    baseline_paving = 150*90-(54*42+math.pi*21**2)-(54*8+math.pi*(32**2-24**2)/2-7.1*8)-288-120-120-12.5
    BUILD_STATS["landscaping"] = {"islands": len(LAWN_ISLANDS), "island_footprint_area": round(island_area, 2),
                                   "previous_visible_paving_area_estimate": round(baseline_paving, 2),
                                   "visible_paving_reduction_estimate": round(island_area/baseline_paving, 4)}

    track = Mesh("Paddock_Track", "PaddockTrack")
    ring(track, 15, 21, 0.02)
    lawn = outline(15)
    for i, a in enumerate(lawn):
        b = lawn[(i+1)%len(lawn)]
        meshes["PaddockLawn"].surface([(0, 0.025, 0), (a[0], 0.025, a[1]), (b[0], 0.025, b[1])])
    ring(meshes["Curb"], 14.85, 15, 0.13, 0.02, gap=True)
    ring(meshes["Hedge"], 13.85, 14.85, 0.525, 0.025, gap=True)
    ring(meshes["Soil"], 12.65, 13.85, 0.08, gap=True)
    meshes["Concrete"].slab(-2, 2, 12.6, 15, 0.028)

    flowers = ((0.73, 0.025, 0.045, 1), (1, 0.66, 0.025, 1),
               (0.90, 0.90, 0.78, 1), (0.38, 0.09, 0.62, 1))
    leaf_triangles, flower_count = 0, 0
    for i in range(140):
        x, z = point_on_ring(13.25, (108+math.tau*13.25)*(i+0.5)/140)
        in_gap = z > 12 and abs(x) < 2.5
        if in_gap:
            continue
        meshes["Hedge"].shrub((x, 0.18, z), (0.83, 0.16, 0.65))
        leaf_triangles += 20
    for row, r in enumerate((13.03, 13.46)):
        for i in range(316):
            station = (108+math.tau*r)*(i+0.5+row*0.5)/316
            x, z = point_on_ring(r, station)
            in_gap = z > 12 and abs(x) < 2.17
            if in_gap:
                continue
            color = flowers[(int(station/3.5)+row)%4]
            h = 0.275+0.015*math.sin(x*3+z*7)
            diameter = 0.30+0.035*math.sin(i*1.7+row)
            meshes["FlowerBed"].flower((x, h, z), diameter, color)
            flower_count += 1
    flowerbed_triangles = flower_count*18+leaf_triangles+sum(len(f)-2 for f in meshes["Soil"].faces)
    assert flowerbed_triangles <= 15_000, flowerbed_triangles
    BUILD_STATS["flowerbed"] = {"flowers": flower_count, "flower_triangles": flower_count*18,
                                 "leaf_triangles": leaf_triangles, "total_with_soil": flowerbed_triangles,
                                 "diameter_range": [0.265, 0.335]}

    alpha = math.asin(3/21)
    runs = [line(-27, -21, 27, -21), arc(27, 21, -math.pi/2, math.pi/2),
            line(27, 21, 24.5, 21), line(19.5, 21, -27, 21),
            arc(-27, 21, math.pi/2, math.pi-alpha), arc(-27, 21, math.pi+alpha, 3*math.pi/2)]
    for path in runs:
        railing(rail, path, base=0)

    for step in range(4):
        inner, outer, height = 24+step*2, 26+step*2, (step+1)*0.45
        strip(concrete, line(-27, -inner, 27, -inner), line(-27, -outer, 27, -outer), height, 0)
        for upper in (True, False):
            def terrace_arc(radius):
                angle = math.asin(3.55/radius)
                start, end = (math.pi/2, math.pi-angle) if upper else (math.pi+angle, 3*math.pi/2)
                return arc(-27, radius, start, end, 64)
            strip(concrete, terrace_arc(inner), terrace_arc(outer), height, 0)

    # The arrival lane has the same track material but is never part of Paddock_Track.
    meshes["PaddockTrack"].slab(19.5, 24.5, 21, 45, 0.02)
    for x in (19.5, 24.5):
        railing(rail, line(x, 21, x, 44.5), levels=(0.65, 1.25))
    for x in (18.8, 25.2):
        concrete.box((x, 0.15, 44.4), (0.9, 0.3, 1.0))
        meshes["RoofSteel"].box((x, 2.25, 44.4), (0.6, 4.5, 0.65))
    meshes["Roof"].box((22, 4.40, 44.4), (7, 0.2, 1.15))
    meshes["RoofSteel"].box((22, 3.88, 44.4), (6.4, 1.04, 0.36))
    gate_sign = panel("SaddlingGateSign", "Sign", (22, 3.88, 44.205), (-1, 0, 0), 6, 0.9)

    # A fitted collar avoids coplanar overlap with the curved track edge.
    boundary = list(reversed(arc(-27, 21, math.pi/2, 3*math.pi/2)))
    for a, b in zip(boundary, boundary[1:]):
        lo, hi = max(-3, a[1]), min(3, b[1])
        outside_opening = hi <= lo
        if outside_opening:
            continue
        def edge_x(z):
            t = (z-a[1])/(b[1]-a[1])
            return a[0]*(1-t)+b[0]*t
        points = [(-48, 0.02, lo), (edge_x(lo), 0.02, lo),
                  (edge_x(hi), 0.02, hi), (-48, 0.02, hi)]
        for indices in ((0, 1, 2), (0, 2, 3)):
            triangle = [points[i] for i in indices]
            p, q, r = (Vector(v) for v in triangle)
            is_degenerate = (q-p).cross(r-p).length < 1e-8
            if is_degenerate:
                continue
            meshes["PaddockTrack"].surface(triangle)
    meshes["PaddockTrack"].slab(-62, -48, -3, 3, 0.02)
    for z in (-3.22, 3.22):
        concrete.box((-55, 0.60, z), (14, 1.2, 0.44))
        for x in (-48.18, -52.7, -57.3, -61.82):
            meshes["RoofSteel"].box((x, 2.80, z), (0.16, 3.2, 0.16))
        meshes["RoofSteel"].box((-55, 4.22, z), (14, 0.18, 0.18))
    meshes["Roof"].box((-55, 4.40, 0), (14, 0.20, 7.3))
    dark = meshes["ConcreteDark"]
    dark.slab(-66, -62, -3, 3, 0.02)
    for z in (-3.5, 3.5):
        concrete.box((-64.25, 3, z), (4.5, 6, 1))
    concrete.box((-66.25, 3, 0), (0.5, 6, 8))
    concrete.box((-64.25, 5.25, 0), (4.5, 1.5, 6))
    # The dark lining lies slightly inside the concrete shell, not in front of the mouth.
    dark.add([(-62,0.02,-2.995), (-66,0.02,-2.995), (-66,4.5,-2.995), (-62,4.5,-2.995)], [(0,3,2,1)])
    dark.add([(-62,0.02,2.995), (-66,0.02,2.995), (-66,4.5,2.995), (-62,4.5,2.995)], [(0,1,2,3)])
    dark.add([(-65.995,0.02,-3), (-65.995,4.5,-3), (-65.995,4.5,3), (-65.995,0.02,3)], [(0,1,2,3)])
    dark.add([(-62,4.495,-3), (-66,4.495,-3), (-66,4.495,3), (-62,4.495,3)], [(0,3,2,1)])

    wall, steel, roof = meshes["BuildingWall"], meshes["RoofSteel"], meshes["Roof"]
    concrete.box((-2, 0.15, 25.5), (24, 0.3, 3))
    wall.box((-2, 2.25, 35.8), (24, 4.5, 0.4))
    for x in (-13.8, 9.8):
        wall.box((x, 2.25, 31.5), (0.4, 4.5, 9))
    concrete.box((-2, 0.15, 31.5), (24, 0.3, 9))
    wall.box((-2, 3.90, 27.13), (24, 1.2, 0.26))
    for i in range(8):
        x = -12.5+3*i
        meshes["Glass"].box((x, 1.82, 27.17), (2.88, 2.98, 0.10))
    for i in range(9):
        steel.box((-14+3*i, 1.82, 27.05), (0.095, 3.04, 0.17))
    for y in (0.34, 3.30):
        steel.box((-2, y, 27.05), (24, 0.08, 0.17))
    for x in (-2.20, -1.80):
        rail.pipe([(x, 1.20, 26.98), (x, 1.80, 26.98)], 0.035)
    roof.box((-2, 4.40, 30.5), (24.8, 0.20, 11))
    steel.box((-2, 4.16, 25.10), (24.6, 0.25, 0.18))
    for x in (-13.7, 9.7):
        steel.box((x, 2.20, 25.20), (0.16, 3.8, 0.16))
    for x0, x1 in ((-14, -4), (0, 10)):
        railing(rail, line(x0, 24, x1, 24), levels=(0.6, 1.15), base=0.3)
    for x in (-14, 10):
        railing(rail, line(x, 24, x, 27), levels=(0.6, 1.15), base=0.3)
    concrete.box((-2, 0.075, 23.65), (4, 0.15, 0.7))
    jockey_sign = panel("JockeyRoomSign", "Sign", (-2, 3.90, 26.985), (-1, 0, 0), 10, 1.2)
    for x in (-9, 5):
        wall.box((x, 0.86, 32.7), (4, 0.16, 0.75))
        for dx in (-1.5, 1.5):
            steel.box((x+dx, 0.53, 32.7), (0.10, 0.58, 0.60))

    frame = meshes["BoardFrame"]
    for z in (-5.0, 5.0):
        concrete.box((54.55, 0.20, z), (2.5, 0.4, 2.5))
        frame.box((54.55, 2.25, z), (0.9, 4.1, 0.9))
    frame.box((54.55, 8.5, 0), (1.1, 10.0, 17))
    for z in (-8.25, 8.25):
        frame.box((53.90, 8.5, z), (0.28, 9.5, 0.5))
    for y in (3.75, 13.25):
        frame.box((53.90, y, 0), (0.28, 0.5, 17))
    for z in (-6, -3, 0, 3, 6):
        steel.box((55.13, 8.5, z), (0.08, 9, 0.10))
    for y in (3.8, 8.5, 13.2):
        steel.box((55.27, y, 0), (0.22, 0.16, 16.4))
    for z0, z1 in ((-8, -4), (-4, 0), (0, 4), (4, 8)):
        steel.pipe([(55.38, 3.9, z0), (55.38, 8.4, z1), (55.38, 13.1, z0)], 0.07, sides=6)
    for z in (6.6, 7.6):
        steel.pipe([(55.95, 0.08, z), (55.95, 13.3, z)], 0.055, sides=8)
    for i in range(42):
        y = 0.3+i*0.31
        steel.pipe([(55.95, y, 6.6), (55.95, y, 7.6)], 0.045, sides=6)
    for y in (0.8, 4.2, 8.0, 12.4):
        for z in (6.6, 7.6):
            steel.pipe([(55.12, y, z), (55.95, y, z)], 0.06, sides=6)
    screen = panel("PaddockBoardScreen", "Screen", (53.755, 8.5, 0), (0, 0, 1), 16, 9)
    return [track, *meshes.values(), screen, jockey_sign, gate_sign]


def read_glb(path):
    raw = path.read_bytes()
    magic, version, size = struct.unpack_from("<4sII", raw)
    assert (magic, version, size) == (b"glTF", 2, len(raw))
    length, kind = struct.unpack_from("<I4s", raw, 12)
    assert kind == b"JSON"
    return json.loads(raw[20:20+length]), raw[28+length:]


def values(doc, binary, index):
    accessor = doc["accessors"][index]
    view = doc["bufferViews"][accessor["bufferView"]]
    count = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    code = {5126: "f", 5125: "I", 5123: "H", 5121: "B"}[accessor["componentType"]]
    fmt = "<"+code*count
    stride = view.get("byteStride", struct.calcsize(fmt))
    start = view.get("byteOffset", 0)+accessor.get("byteOffset", 0)
    return [struct.unpack_from(fmt, binary, start+i*stride) for i in range(accessor["count"])]


def bounds(points):
    return {"min": [round(min(p[i] for p in points), 5) for i in range(3)],
            "max": [round(max(p[i] for p in points), 5) for i in range(3)]}


def inspect(path, objects):
    doc, binary = read_glb(path)
    assert not any(doc.get(key) for key in ("images", "textures", "animations", "cameras"))
    assert not any("compression" in key.lower() for key in doc.get("extensionsUsed", []))
    assert {m["name"] for m in doc["materials"]} == set(PALETTE)
    assert {n["name"] for n in doc["nodes"]} == {o.name for o in objects}
    panels = {"PaddockBoardScreen": ((-1, 0, 0), (0, 0, 1), 16, 9),
              "JockeyRoomSign": ((0, 0, -1), (-1, 0, 0), 10, 1.2),
              "SaddlingGateSign": ((0, 0, -1), (-1, 0, 0), 6, 0.9)}
    result, all_points = {}, []
    for node in doc["nodes"]:
        name = node["name"]
        assert "rotation" not in node and "scale" not in node and "matrix" not in node
        translation = node.get("translation", [0, 0, 0])
        assert name in panels or translation == [0, 0, 0]
        primitives = doc["meshes"][node["mesh"]]["primitives"]
        assert len(primitives) == 1
        primitive = primitives[0]
        attributes = primitive["attributes"]
        positions = values(doc, binary, attributes["POSITION"])
        normals = values(doc, binary, attributes["NORMAL"])
        indices = values(doc, binary, primitive["indices"])
        world = [tuple(p[i]+translation[i] for i in range(3)) for p in positions]
        all_points.extend(world)
        is_panel = name in panels
        if is_panel:
            normal, right, width, height = panels[name]
            assert len(indices) == 6 and len(positions) == 4
            assert all(Vector(n).dot(Vector(normal)) > 0.999 for n in normals)
            uvs = values(doc, binary, attributes["TEXCOORD_0"])
            for p, uv in zip(positions, uvs):
                assert abs(uv[0]-(Vector(p).dot(Vector(right))/width+0.5)) < 1e-5
                assert abs(uv[1]-(0.5+p[1]/height)) < 1e-5
        is_track = name == "Paddock_Track"
        if is_track:
            assert node["extras"] == EXTRAS
            for x, y, z in positions:
                r = math.hypot(max(0, abs(x)-27), z)
                assert min(abs(r-15), abs(r-21)) < 1e-4
                assert abs(y-0.02) < 1e-6
            assert all(n[1] > 0.999 for n in normals)
        is_flower = name == "Paddock_FlowerBed"
        if is_flower:
            assert "COLOR_0" in attributes
            assert len(set(values(doc, binary, attributes["COLOR_0"]))) >= 4
        result[name] = {"triangles": len(indices)//3, "vertices": len(positions),
                        "source_vertices": len(next(o for o in objects if o.name == name).data.vertices),
                        "bounding_box": bounds(world), "local_bounding_box": bounds(positions),
                        "translation": translation, "materials": [doc["materials"][primitive["material"]]["name"]],
                        "extras": node.get("extras", {})}
    triangles = sum(n["triangles"] for n in result.values())
    size = path.stat().st_size
    assert min(p[1] for p in all_points) >= -1e-6
    assert BUILD_STATS["flowerbed"]["total_with_soil"] <= 15_000
    assert triangles <= 60_000, triangles
    assert size <= 1_500_000, size
    return {"nodes": result, "node_count": len(result), "triangles": triangles,
            "vertices": sum(n["vertices"] for n in result.values()), "bounding_box": bounds(all_points),
            "glb_bytes": size, "glb_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "extras": EXTRAS, "checks_passed": True,
            "checks": ["exact track radius/width/height", "track extras", "node/material names", "identity rotations/scales",
                       "panel outward normals and UV orientation", "flower COLOR_0", "no images/animations/cameras/compression",
                       "triangle and byte budgets", "all geometry at or above ground", "flowerbed under 15000 triangles"],
            "semicircle_segments": ARC_SEGMENTS, "revision_details": BUILD_STATS,
            "integration_note": "Continuous scene ground is supported. Level covered exit x=[-62,-48], mouth x=-62, dead end x=-66."}


def previews(directory, materials, samples, only):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.seed = 0
    scene.cycles.use_animated_seed = False
    scene.render.resolution_x, scene.render.resolution_y = 1600, 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("PreviewSky")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes.get("Background").inputs["Color"].default_value = (0.43, 0.66, 0.88, 1)
    world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0.5
    sun = bpy.data.objects.new("PreviewSun", bpy.data.lights.new("PreviewSun", "SUN"))
    bpy.context.collection.objects.link(sun)
    sun.data.energy, sun.data.angle = 2.3, math.radians(5)
    sun.rotation_euler = native((0.4, -1, 0.65)).to_track_quat("-Z", "Y").to_euler()

    props = Mesh("PreviewScaleHorses", "PreviewHorse")
    materials["PreviewHorse"] = material("PreviewHorse", (0.16, 0.067, 0.028))
    for x, z in ((-12, -18), (5, -18), (-19, 18)):
        props.box((x, 1.22, z), (2.4, 2.4, 0.7))
    props.finish(materials)
    people = Mesh("PreviewScalePeople", "PreviewPerson")
    materials["PreviewPerson"] = material("PreviewPerson", (0.08, 0.17, 0.24))
    for i, x in enumerate((-25, -22, -19, -16, 12, 15, 18, 21, 24, 26)):
        step = i%4
        z, base = -(25+step*2), (step+1)*0.45
        people.pipe([(x, base, z), (x, base+2.6, z)], 0.28, sides=12)
    people.finish(materials)
    # Match the host scene's uninterrupted ground to expose any below-grade geometry.
    surround = Mesh("PreviewSurroundingLawn", "PaddockLawn")
    surround.slab(-500, 500, -500, 500, -0.01)
    surround.finish(materials)

    camera = bpy.data.objects.new("PreviewCamera", bpy.data.cameras.new("PreviewCamera"))
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    camera.data.sensor_fit = "VERTICAL"
    camera.data.clip_start, camera.data.clip_end = 0.05, 2000
    views = {"overview": ((70, 55, -85), (0, 0, 0), 45),
             "from_track": ((-10, 12, -150), (0, 2, 0), 25),
             "top": ((0, 180, 0), (0, 0, 0), 45),
             "ring_side": ((0, 2.6, -28), (-10, 1.2, -18), 50),
             "board": ((-20, 6, 0), (54, 8.5, 0), 35),
             "exit": ((-30, 6, 14), (-58, 2, 0), 50),
             "jockey_room": ((0, 4, -8), (0, 2, 30), 50),
             "entrance": ((18, 3, 10), (22, 2, 40), 50),
             "exit_mouth": ((-47, 2.8, 0), (-62, 2.1, 0), 45),
             "board_back": ((73, 11, -18), (55.5, 7, 0), 45),
             "flowers": ((-3, 1.6, -11), (0, 0.25, -13.25), 42)}
    for name, (eye, target, angle) in views.items():
        skip = bool(only) and name not in only
        if skip:
            continue
        camera.location = native(eye)
        camera.rotation_euler = (native(target)-camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.type = "ORTHO" if name == "top" else "PERSP"
        camera.data.ortho_scale = 96
        # three.js PerspectiveCamera uses vertical FOV; horizontal FOV crops the oval.
        camera.data.lens = camera.data.sensor_height / (2*math.tan(math.radians(angle)/2))
        scene.render.filepath = str(directory / (name+".png"))
        bpy.ops.render.render(write_still=True)
    return views


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-previews", action="store_true")
    parser.add_argument("--verify-repeat", action="store_true", help="Rebuild and compare GLB bytes; retain the full render statistics.")
    parser.add_argument("--views", nargs="*", default=[])
    parser.add_argument("--samples", type=int, choices=range(32, 65), default=32)
    has_args = "--" in sys.argv
    args = parser.parse_args(sys.argv[sys.argv.index("--")+1:] if has_args else [])
    started = time.perf_counter()
    previous_digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest() if OUTPUT.is_file() else None
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    materials = {name: material(name, rgb) for name, rgb in PALETTE.items()}
    objects = [mesh.finish(materials) for mesh in build()]
    for obj in objects:
        obj.select_set(True)
        is_track = obj.name == "Paddock_Track"
        if is_track:
            for key, value in EXTRAS.items():
                obj[key] = value
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(filepath=str(OUTPUT), export_format="GLB", use_selection=True,
                              export_yup=True, export_extras=True, export_animations=False,
                              export_cameras=False, export_lights=False, export_texcoords=True,
                              export_normals=True, export_materials="EXPORT")
    stats = inspect(OUTPUT, objects)
    stats["matches_previous_export"] = previous_digest == stats["glb_sha256"]
    if args.verify_repeat:
        assert stats["matches_previous_export"], "GLB differs from the preceding build"
        verification = {"matches_previous_export": True, "glb_sha256": stats["glb_sha256"],
                        "glb_bytes": stats["glb_bytes"], "generation_seconds": round(time.perf_counter()-started, 3)}
        encoded = json.dumps(verification, indent=2)
        (PREVIEW_DIR / "reproducibility.json").write_text(encoded+"\n", encoding="utf-8")
        stats_path = PREVIEW_DIR / "stats.json"
        has_stats = stats_path.is_file()
        if has_stats:
            rendered_stats = json.loads(stats_path.read_text(encoding="utf-8"))
            is_same_model = rendered_stats.get("glb_sha256") == stats["glb_sha256"]
            if is_same_model:
                rendered_stats["matches_previous_export"] = True
                rendered_stats["reproducibility"] = verification
                stats_path.write_text(json.dumps(rendered_stats, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
        print(encoded, flush=True)
        return
    stats["model_generation_seconds"] = round(time.perf_counter()-started, 3)
    should_render = not args.skip_previews
    if should_render:
        stats["preview_cameras"] = previews(PREVIEW_DIR, materials, args.samples, args.views)
    stats["generation_seconds"] = round(time.perf_counter()-started, 3)
    stats["blender_version"] = bpy.app.version_string
    stats["preview_renderer"] = {"engine": "CYCLES", "device": "CPU", "samples": args.samples, "rendered": should_render}
    stats["coordinate_system"] = "Game +Y up, X long axis, -Z spectator side. Bounds are game world units."
    stats["preview_fov_convention"] = "Vertical FOV, matching three.js PerspectiveCamera."
    stats["panel_uv_convention"] = "Exported GLB front bottom-left=(0,0), top-right=(1,1)."
    encoded = json.dumps(stats, ensure_ascii=False, indent=2)
    (PREVIEW_DIR / "stats.json").write_text(encoded+"\n", encoding="utf-8")
    print(encoded, flush=True)


if __name__ == "__main__":
    main()
