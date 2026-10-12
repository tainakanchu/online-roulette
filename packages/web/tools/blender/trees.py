# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic, texture-free trees; run with Blender's bundled Python.

Blender -b --factory-startup -noaudio --python trees.py -- [--skip-previews]
Geometry is authored Z-up, and the glTF exporter converts it to Y-up.
"""

import argparse
from collections import deque
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

import bpy
import numpy as np
from mathutils import Quaternion, Vector

# プレビュー画像と統計の出力先。環境変数 BLENDER_PREVIEW_DIR で変えられる（既定は OS の一時フォルダー）
DEFAULT_PREVIEW = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "trees"
ROOT = Path(__file__).resolve().parents[4]
TAU = math.tau


def vec(x=0, y=0, z=0):
    return Vector((x, y, z))


def frame(direction):
    axis = direction.normalized()
    reference = vec(0, 0, 1) if abs(axis.z) < 0.93 else vec(1, 0, 0)
    side = axis.cross(reference).normalized()
    return side, axis.cross(side).normalized()


class MeshBuilder:
    def __init__(self):
        self.vertices = []
        self.faces = []
        self.colors = []

    def add(self, vertices, faces, colors):
        offset = len(self.vertices)
        self.vertices.extend(tuple(v) for v in vertices)
        self.faces.extend(tuple(offset + index for index in face) for face in faces)
        self.colors.extend(colors)

    def tube(self, points, radii, sides, tone, phase=0):
        vertices, colors, faces = [], [], []
        for index, point in enumerate(points):
            previous = points[max(0, index - 1)]
            following = points[min(len(points) - 1, index + 1)]
            u, v = frame(following - previous)
            for segment in range(sides):
                angle = TAU * segment / sides + phase
                ridge = 1 + 0.07 * math.sin(segment * 4.1 + index * 0.8)
                vertices.append(point + (u * math.cos(angle) + v * math.sin(angle)) * radii[index] * ridge)
                root_shade = 0.66 + 0.34 * min(1, max(0, point.z) / 1.5)
                grooves = 0.88 + 0.12 * math.cos(segment * 2.7 + phase)
                shade = root_shade * grooves
                colors.append((*[channel * shade for channel in tone], 1))
        for ring in range(len(points) - 1):
            for segment in range(sides):
                a = ring * sides + segment
                b = ring * sides + (segment + 1) % sides
                faces.append((a, b, b + sides, a + sides))
        faces.append(tuple(reversed(range(sides))))
        faces.append(tuple((len(points) - 1) * sides + j for j in range(sides)))
        self.add(vertices, faces, colors)

    def object(self, name, material):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata(self.vertices, [], self.faces)
        mesh.update()
        color = mesh.color_attributes.new(name="COLOR_0", type="BYTE_COLOR", domain="POINT")
        for entry, rgba in zip(color.data, self.colors):
            entry.color = rgba
        for polygon in mesh.polygons:
            polygon.use_smooth = True
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        mesh.materials.append(material)
        return obj


def make_material(name, base_color):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*base_color, 1)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    bsdf.inputs["Roughness"].default_value = 0.86
    bsdf.inputs["Base Color"].default_value = (*base_color, 1)
    # A vertex attribute gives the exporter COLOR_0 without texture dependencies.
    attribute = nodes.new("ShaderNodeVertexColor")
    attribute.layer_name = "COLOR_0"
    multiply = nodes.new("ShaderNodeMix")
    multiply.data_type = "RGBA"
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = 1
    multiply.inputs[7].default_value = (*base_color, 1)
    material.node_tree.links.new(attribute.outputs["Color"], multiply.inputs[6])
    material.node_tree.links.new(multiply.outputs[2], bsdf.inputs["Base Color"])
    material.use_backface_culling = False
    return material


def curved(start, end, bend, count):
    return [start.lerp(end, t / count) + bend * math.sin(math.pi * t / count) for t in range(count + 1)]


def leaf_color(rng, position, height, radius, conifer=False):
    palettes = (
        [(0.13, 0.32, 0.075), (0.20, 0.39, 0.10), (0.29, 0.43, 0.095), (0.09, 0.25, 0.06)]
        if not conifer else
        [(0.055, 0.18, 0.13), (0.075, 0.235, 0.175), (0.10, 0.265, 0.20), (0.04, 0.145, 0.115)]
    )
    tone = rng.choice(palettes)
    radial = min(1, math.hypot(position.x, position.y) / radius)
    vertical = max(0, min(1, position.z / height))
    shade = (0.49 + 0.25 * radial + 0.26 * vertical) * rng.uniform(0.83, 1.17)
    return tuple(min(1, channel * shade) for channel in tone)


def broad_leaf(mesh, base, direction, normal, length, width, color, glossy=False):
    axis = direction.normalized()
    lateral = normal.cross(axis).normalized()
    # Six outline vertices preserve rounded shoulders with four triangles.
    # The shared base-to-tip edge is the raised midrib, not a flat diamond.
    vertices = [
        base,
        base + axis * length * 0.29 + lateral * width * 0.86 - normal * length * 0.055,
        base + axis * length * 0.68 + lateral * width - normal * length * 0.064,
        base + axis * length,
        base + axis * length * 0.68 - lateral * width - normal * length * 0.064,
        base + axis * length * 0.29 - lateral * width * 0.86 - normal * length * 0.055,
    ]
    shades = (0.60, 0.78, 1.24, 1.55, 0.97, 0.66) if glossy else (0.80, 0.89, 1.03, 1.12, 0.91, 0.79)
    colors = [(*[c * shade for c in color], 1) for shade in shades]
    mesh.add(vertices, [(0, 3, 2), (0, 2, 1), (0, 5, 4), (0, 4, 3)], colors)


def bounds_of(vertices):
    vertices = list(vertices)
    return (
        vec(*[min(v[axis] for v in vertices) for axis in range(3)]),
        vec(*[max(v[axis] for v in vertices) for axis in range(3)]),
    )


def bumpy_blob(mesh, bounds, tone, rng, sides=9, rings=5):
    low, high = bounds
    center = (low + high) * 0.5
    radius = (high - low) * 0.52
    vertices = [center + vec(0, 0, radius.z)]
    colors = [(*[c * 1.18 for c in tone], 1)]
    faces = []
    phase = rng.uniform(0, TAU)
    for ring in range(1, rings):
        phi = math.pi * ring / rings
        for segment in range(sides):
            angle = TAU * segment / sides + phase
            bulge = 1 + 0.13 * math.sin(angle * 3 + ring * 1.6) + rng.uniform(-0.045, 0.045)
            offset = vec(
                math.sin(phi) * math.cos(angle) * radius.x * bulge,
                math.sin(phi) * math.sin(angle) * radius.y * bulge,
                math.cos(phi) * radius.z + rng.uniform(-0.07, 0.07) * radius.z,
            )
            vertices.append(center + offset)
            shade = 0.64 + 0.43 * (0.5 + 0.5 * math.cos(phi)) + rng.uniform(-0.09, 0.09)
            colors.append((*[c * shade for c in tone], 1))
    bottom = len(vertices)
    vertices.append(center - vec(0, 0, radius.z))
    colors.append((*[c * 0.55 for c in tone], 1))
    for segment in range(sides):
        next_segment = (segment + 1) % sides
        faces.append((0, 1 + segment, 1 + next_segment))
        for ring in range(rings - 2):
            a = 1 + ring * sides + segment
            b = 1 + ring * sides + next_segment
            faces.append((a, a + sides, b + sides, b))
        faces.append((bottom, 1 + (rings - 2) * sides + next_segment,
                      1 + (rings - 2) * sides + segment))
    mesh.add(vertices, faces, colors)


def add_roots(wood, low_wood, rng, size, tone):
    for index in range(6):
        angle = TAU * index / 6 + rng.uniform(-0.15, 0.15)
        outward = vec(math.cos(angle), math.sin(angle), 0)
        points = [outward * size * 2 + vec(0, 0, 0.025),
                  outward * size * 0.7 + vec(0, 0, 0.18), vec(0, 0, 0.64)]
        wood.tube(points, [0.02, size * 0.38, size * 0.52], 3, tone)
        low_wood.tube([points[0], points[2]], [0.02, size * 0.52], 3, tone)


def twig_ribbon(mesh, start, end, tone, width=0.008):
    side, _ = frame(end - start)
    mesh.add([start - side * width, end, start + side * width],
             [(0, 1, 2)], [(*[c * 0.82 for c in tone], 1)] * 3)


def fit_proxy_bounds(reference, proxy):
    low, high = bounds_of(reference.vertices)
    proxy_low, proxy_high = bounds_of(proxy.vertices)
    scale = [(high[i] - low[i]) / (proxy_high[i] - proxy_low[i]) for i in range(3)]
    proxy.vertices = [tuple(low[i] + (v[i] - proxy_low[i]) * scale[i] for i in range(3))
                      for v in proxy.vertices]


def broadleaf_tone(rng, kind, local_height, inner):
    is_keyaki = kind == "keyaki"
    palette = (
        [(0.24, 0.43, 0.055), (0.31, 0.48, 0.075),
         (0.18, 0.34, 0.035), (0.36, 0.52, 0.10)]
        if is_keyaki else
        [(0.035, 0.145, 0.055), (0.055, 0.21, 0.075),
         (0.10, 0.29, 0.09), (0.15, 0.32, 0.095)]
    )
    color = rng.choice(palette)
    shade = (0.76 + 0.22 * local_height) * (0.78 if inner else 1)
    shade *= rng.uniform(0.87, 1.13) if is_keyaki else rng.uniform(0.65, 1.35)
    return tuple(channel * shade for channel in color)


def exposed_rosettes(group, groups, group_index, phase):
    center, radii, count = group
    center, radii = Vector(center), Vector(radii)
    crown_center = sum((Vector(other[0]) for other in groups), vec()) / len(groups)
    candidates = []
    for index in range(count * 20):
        t = -0.96 + 1.94 * (index + 0.5) / (count * 20)
        angle = index * 2.399963 + phase
        radial = math.sqrt(1 - t * t)
        local = vec(radial * math.cos(angle), radial * math.sin(angle), t)
        position = center + vec(local.x * radii.x, local.y * radii.y, local.z * radii.z)
        surface_normal = vec(local.x / radii.x, local.y / radii.y, local.z / radii.z).normalized()
        facing_interior = surface_normal.dot((position - crown_center).normalized()) < 0.12
        buried = any(
            sum(((position[axis] - other[0][axis]) / other[1][axis]) ** 2
                for axis in range(3)) < 0.99 ** 2
            for other_index, other in enumerate(groups) if other_index != group_index
        )
        is_hidden_surface = buried or facing_interior
        if is_hidden_surface:
            continue
        candidates.append((position, local))
    assert len(candidates) >= count, (group_index, len(candidates), count)
    # Even spacing on the exposed union avoids wasting leaves inside adjacent crowns.
    distances = [float("inf")] * len(candidates)
    selected = 0
    result = []
    for _ in range(count):
        point = candidates[selected][0]
        result.append(candidates[selected])
        distances = [min(distance, (candidate[0] - point).length_squared)
                     for distance, candidate in zip(distances, candidates)]
        selected = max(range(len(candidates)), key=distances.__getitem__)
    return result


def normalize_broadleaf(builders, height):
    # A common scale preserves the inset LOD1 instead of stretching it to LOD0 height.
    maximum = max(v[2] for builder in builders[:2] for v in builder.vertices)
    scale = height / maximum
    for builder in builders:
        builder.vertices = [(x, y, max(0, z) * scale) for x, y, z in builder.vertices]
    return builders


def branch_crown(builders, kind, group, group_index, rng, proxy_rng, tone,
                 groups, scaffold=None):
    wood, leaves, low_wood, low_leaves = builders
    center, radii, _ = group
    center, radii = Vector(center), Vector(radii)
    is_keyaki = kind == "keyaki"
    radial = vec(center.x, center.y, 0).normalized()
    needs_primary = scaffold is None
    if needs_primary:
        origin = vec(0.03, 0.02, 1.25 + group_index * 0.11)
        primary_end = center - vec(0, 0, radii.z * 0.35)
        path = curved(origin, primary_end, radial * 0.24 - vec(0, 0, 0.22), 3)
        wood.tube(path, [0.24, 0.17, 0.11, 0.035], 4, tone)
        low_wood.tube([path[0], path[1], path[3]], [0.24, 0.17, 0.025], 3, tone)
    else:
        primary_end = scaffold
    secondary_count = 2 if is_keyaki else 5
    secondary_tips = []
    for secondary in range(secondary_count):
        angle = TAU * secondary / secondary_count + group_index * 0.81
        offset = vec(math.cos(angle) * radii.x * 0.53,
                     math.sin(angle) * radii.y * 0.53, radii.z * rng.uniform(-0.10, 0.32))
        end = center + offset
        wood.tube([primary_end, end], [0.045 if is_keyaki else 0.065, 0.009], 3, tone)
        secondary_tips.append(end)
    first_vertex = len(leaves.vertices)
    phase = rng.uniform(0, TAU)
    crown_center = sum((Vector(other[0]) for other in groups), vec()) / len(groups)
    for position, local in exposed_rosettes(group, groups, group_index, phase):
        position += vec(rng.uniform(-0.015, 0.015), rng.uniform(-0.015, 0.015), rng.uniform(-0.015, 0.015))
        outward = position - crown_center
        outward.z = max(0.35, outward.z * 0.30)
        outward.normalize()
        local_normal = vec(local.x, local.y, local.z * 0.65) + vec(0, 0, 0.15)
        normal = (outward * 0.40 + local_normal.normalized() * 0.60).normalized()
        endpoint = min(secondary_tips, key=lambda point: (point - position).length_squared)
        twig_ribbon(wood, endpoint, position, tone, width=0.006)
        u, v = frame(normal)
        rosette_phase = rng.uniform(0, TAU)
        for leaf_index in range(7):
            angle = rosette_phase + TAU * leaf_index / 7 + rng.uniform(-0.30, 0.30)
            direction = (u * math.cos(angle) + v * math.sin(angle)).normalized()
            leaf_normal = (normal + direction * rng.uniform(-0.22, 0.22)
                           + normal.cross(direction) * rng.uniform(-0.22, 0.22)).normalized()
            length = rng.uniform(0.140, 0.157) if is_keyaki else rng.uniform(0.190, 0.205)
            base = position + direction * rng.uniform(0.05, 0.10) + normal * rng.uniform(-0.045, 0.045)
            color = broadleaf_tone(rng, kind, (local.z + 1) * 0.5, False)
            broad_leaf(leaves, base, direction, leaf_normal, length,
                       length * rng.uniform(0.35, 0.41), color, glossy=not is_keyaki)
    patch_bounds = bounds_of(leaves.vertices[first_vertex:])
    proxy = MeshBuilder()
    bumpy_blob(proxy, patch_bounds, broadleaf_tone(proxy_rng, kind, 0.65, False),
               proxy_rng, sides=8 if is_keyaki else 12, rings=5 if is_keyaki else 6)
    reference = MeshBuilder()
    reference.vertices = leaves.vertices[first_vertex:]
    fit_proxy_bounds(reference, proxy)
    midpoint = (patch_bounds[0] + patch_bounds[1]) * 0.5
    proxy.vertices = [tuple(midpoint + (Vector(vertex) - midpoint) * 0.88)
                      for vertex in proxy.vertices]
    has_patches = hasattr(leaves, "foliage_patches")
    if not has_patches:
        leaves.foliage_patches = []
    leaves.foliage_patches.append({
        "center": tuple(center), "radii": tuple(radii),
        "first": first_vertex, "stop": len(leaves.vertices),
        "raw_first": leaves.vertices[first_vertex],
        "proxy_first": len(low_leaves.vertices),
        "proxy_stop": len(low_leaves.vertices) + len(proxy.vertices),
    })
    low_leaves.add(proxy.vertices, proxy.faces, proxy.colors)


def refine_broadleaf_foliage(builders, kind):
    # Refining after normalization leaves every accepted branch vertex untouched.
    leaves, proxy = builders[1], builders[3]
    rng = random.Random(53041 if kind == "keyaki" else 53063)
    patches = leaves.foliage_patches
    accepted_vertices = list(leaves.vertices)
    boxes = [bounds_of(leaves.vertices[p["first"]:p["stop"]]) for p in patches]
    groups = [((low + high) * 0.5, (high - low) * 0.5) for low, high in boxes]
    tree_center = sum((center for center, _ in groups), vec()) / len(groups)
    leaf_specs = []
    for patch_index, patch in enumerate(patches):
        center, radii = groups[patch_index]
        first, stop = patch["first"], patch["stop"]
        reference = leaves.vertices[first:stop]
        low, high = bounds_of(reference)
        count = (stop - first) // 6
        rosette_count = count // 7
        outer_count = round(rosette_count * 0.70)
        order = [True] * outer_count + [False] * (rosette_count - outer_count)
        rng.shuffle(order)

        def concealed(point):
            return any(sum(((point[a] - c[a]) / r[a]) ** 2 for a in range(3)) < 1.01 ** 2
                       for i, (c, r) in enumerate(groups) if i != patch_index)

        pools = {True: [], False: []}
        phase = rng.uniform(0, TAU)
        for shell in (True, False):
            for index in range(rosette_count * 70):
                t = -0.97 + 1.94 * (index + 0.5) / (rosette_count * 70)
                angle = index * 2.399963 + phase
                radial = math.sqrt(1 - t * t)
                unit = vec(radial * math.cos(angle), radial * math.sin(angle), t)
                radius = rng.uniform(0.86, 0.96) if shell else rng.uniform(0.60, 0.72)
                point = center + vec(*[unit[a] * radii[a] * radius for a in range(3)])
                inward = (point - center).normalized().dot((point - tree_center).normalized()) < 0.03
                is_hidden = concealed(point) or inward
                if is_hidden:
                    continue
                pools[shell].append(point)
            assert pools[shell], (kind, patch_index, shell)
        distances = {shell: [float("inf")] * len(pool) for shell, pool in pools.items()}
        result = MeshBuilder()
        classifications = []
        for shell in order:
            pool = pools[shell]
            selected = max(range(len(pool)), key=distances[shell].__getitem__)
            anchor = pool[selected]
            for other_shell, other_pool in pools.items():
                distances[other_shell] = [min(d, (point - anchor).length_squared)
                                          for d, point in zip(distances[other_shell], other_pool)]
            normal = (anchor - center).normalized()
            u, v = frame(normal)
            phase = rng.uniform(0, TAU)
            for leaf_index in range(7):
                length = 0.19 + 0.02 * rng.random() ** 0.25 if kind == "keyaki" else rng.triangular(0.25, 0.28, 0.28)
                angle = phase + TAU * leaf_index / 7 + rng.uniform(-0.10, 0.10)
                tangent = u * math.cos(angle) + v * math.sin(angle)
                midpoint = anchor + tangent * length * rng.uniform(0.78, 0.90)
                radial = vec(*[(midpoint[a] - center[a]) / radii[a] for a in range(3)])
                target_radius = min(0.97 if shell else 0.735, radial.length)
                radial.normalize()
                midpoint = center + vec(*[radial[a] * radii[a] * target_radius for a in range(3)])
                is_concealed = concealed(midpoint)
                if is_concealed:
                    midpoint = min(pool, key=lambda p: (p - midpoint).length_squared)
                outward = (midpoint - center).normalized()
                a, b = frame(outward)
                tilt = rng.uniform(0, math.radians(17))
                tilt_angle = rng.uniform(0, TAU)
                normal = (outward * math.cos(tilt)
                          + (a * math.cos(tilt_angle) + b * math.sin(tilt_angle)) * math.sin(tilt))
                direction = (tangent - normal * tangent.dot(normal)).normalized()
                color = broadleaf_tone(rng, kind, (midpoint.z - low.z) / (high.z - low.z), not shell)
                broad_leaf(result, midpoint - direction * length * 0.5, direction, normal,
                           length, length * rng.uniform(0.41 if kind == "keyaki" else 0.35,
                                                0.45 if kind == "keyaki" else 0.41),
                           color, glossy=kind == "kusu")
                classifications.append(shell)
        # Move whole leaves; neither the blade dimensions nor accepted branch mesh is scaled.
        for offset in range(0, len(result.vertices), 6):
            points = [Vector(p) for p in result.vertices[offset:offset + 6]]
            shell = classifications[offset // 6]
            spec = {"group": patch_index, "shell": shell, "bounds": (low, high), "pinned": False}
            is_valid = valid_leaf_placement(points, spec, groups)
            if not is_valid:
                midpoint = (points[0] + points[3]) * 0.5
                for candidate in sorted(pools[shell], key=lambda p: (p - midpoint).length_squared):
                    moved = place_leaf(points, candidate, (candidate - center).normalized())
                    is_valid = valid_leaf_placement(moved, spec, groups)
                    if is_valid:
                        points = moved
                        break
                assert is_valid, (kind, patch_index, shell)
            result.vertices[offset:offset + 6] = [tuple(p) for p in points]
            leaf_specs.append(spec)
        leaves.vertices[first:stop] = result.vertices
        leaves.colors[first:stop] = result.colors

        start, end = patch["proxy_first"], patch["proxy_stop"]
        points = [Vector(p) for p in proxy.vertices[start:end]]
        p_low, p_high = bounds_of(points)
        p_center = (p_low + p_high) * 0.5
        protected = {choose(range(len(points)), key=lambda i: points[i][axis])
                     for axis in range(3) for choose in (min, max)}
        for index, point in enumerate(points):
            keep_extent = index in protected
            indentation = 0 if keep_extent else rng.uniform(0.10, 0.24) * (0.45 + 0.55 * (index % 3 != 0))
            proxy.vertices[start + index] = tuple(p_center + (point - p_center) * (1 - indentation))
            height = abs((point.z - p_center.z) / ((p_high.z - p_low.z) * 0.5))
            edge_shade = 0.78 + 0.22 * height
            color = proxy.colors[start + index]
            proxy.colors[start + index] = (*[c * edge_shade * (1 - indentation * 0.6) for c in color[:3]], 1)
    # Six extremal leaves hold the accepted crown bounds without filling hidden clump seams.
    for axis in range(3):
        for side, choose in ((-1, min), (1, max)):
            group_index = choose(range(len(groups)), key=lambda i: groups[i][0][axis] + side * groups[i][1][axis])
            center, radii = groups[group_index]
            outward = vec(*[side if a == axis else 0 for a in range(3)])
            midpoint = center + outward * radii[axis]
            candidates = [i for i, spec in enumerate(leaf_specs)
                          if spec["group"] == group_index and spec["shell"] and not spec["pinned"]]
            index = min(candidates, key=lambda i: (Vector(leaves.vertices[i * 6]) - midpoint).length_squared)
            points = [Vector(p) for p in leaves.vertices[index * 6:index * 6 + 6]]
            moved = place_leaf(points, midpoint, outward)
            assert valid_leaf_placement(moved, leaf_specs[index], groups), (kind, axis, side)
            leaves.vertices[index * 6:index * 6 + 6] = [tuple(p) for p in moved]
            leaf_specs[index]["pinned"] = True
    optimize_leaf_coverage(leaves, leaf_specs, groups, accepted_vertices, rng,
                           sweeps=6 if kind == "keyaki" else 3)
    measurements = []
    face_angles = []
    for index, spec in enumerate(leaf_specs):
        points = [Vector(p) for p in leaves.vertices[index * 6:index * 6 + 6]]
        center, radii = groups[spec["group"]]
        midpoint = (points[0] + points[3]) * 0.5
        radius = math.sqrt(sum(((midpoint[a] - center[a]) / radii[a]) ** 2 for a in range(3)))
        normal = (points[3] - points[0]).cross(points[2] - points[4]).normalized()
        angle = math.degrees(math.acos(min(1, abs(normal.dot((midpoint - center).normalized())))))
        for a, b, c in ((0, 3, 2), (0, 2, 1), (0, 5, 4), (0, 4, 3)):
            face_normal = (points[b] - points[a]).cross(points[c] - points[a]).normalized()
            face_angles.append(math.degrees(math.acos(min(1, abs(face_normal.dot((midpoint - center).normalized()))))))
        assert valid_leaf_placement(points, spec, groups), (kind, index)
        measurements.append((radius, angle, False))
    shell_count = sum(0.75 <= r <= 1.001 for r, _, _ in measurements)
    shell_fraction = shell_count / len(measurements)
    assert 0.69 <= shell_fraction <= 0.71
    assert max(a for _, a, _ in measurements) <= 35
    assert max(face_angles) <= 35
    original_low, original_high = bounds_of(accepted_vertices)
    current_low, current_high = bounds_of(leaves.vertices)
    assert (current_low - original_low).length < 1e-5 and (current_high - original_high).length < 1e-5
    return {
        "foliage_generator": "bounded_shell_rosettes_v5",
        "distribution_reference": "leaf_midpoint_in_approved_clump_bbox_ellipsoid",
        "shell_leaf_count": shell_count,
        "shell_leaf_fraction": round(shell_fraction, 5),
        "inner_leaf_count": sum(r < 0.75 for r, _, _ in measurements),
        "outside_shell_count": sum(r > 1.001 for r, _, _ in measurements),
        "leaf_normal_max_angle_degrees": round(max(a for _, a, _ in measurements), 3),
        "leaf_face_max_angle_degrees": round(max(face_angles), 3),
        "neighbor_occluded_leaf_count": sum(hidden for _, _, hidden in measurements),
        "distribution_radius_range": [round(min(r for r, _, _ in measurements), 4),
                                       round(max(r for r, _, _ in measurements), 4)],
        "projected_leaf_coverage": projected_leaf_coverage(leaves, accepted_vertices),
    }


def place_leaf(points, midpoint, normal, spin=0):
    old_midpoint = (points[0] + points[3]) * 0.5
    old_normal = (points[3] - points[0]).cross(points[2] - points[4]).normalized()
    rotation = Quaternion(normal, spin) @ old_normal.rotation_difference(normal)
    return [midpoint + rotation @ (point - old_midpoint) for point in points]


def valid_leaf_placement(points, spec, groups):
    midpoint = (points[0] + points[3]) * 0.5
    center, radii = groups[spec["group"]]
    radius = sum(((midpoint[a] - center[a]) / radii[a]) ** 2 for a in range(3)) ** 0.5
    lower, upper = (0.75 - 1e-5, 1 + 1e-5) if spec["shell"] else (0.40, 0.75 - 1e-5)
    invalid_radius = not lower <= radius <= upper
    if invalid_radius:
        return False
    low, high = spec["bounds"]
    outside_bounds = any(not low[a] - 1e-5 <= p[a] <= high[a] + 1e-5 for p in points for a in range(3))
    if outside_bounds:
        return False
    return not any(sum(((midpoint[a] - c[a]) / r[a]) ** 2 for a in range(3)) < 1.00001
                   for i, (c, r) in enumerate(groups) if i != spec["group"])


def optimize_leaf_coverage(leaves, specs, groups, reference, rng, sweeps):
    size = 192
    projections = []
    areas = []
    for index in range(16):
        angle = math.atan2(-22, 11) + index * math.pi / 16
        view = vec(math.cos(angle), math.sin(angle), 3 / math.hypot(11, 22)).normalized()
        right = view.cross(vec(0, 0, 1)).normalized()
        up = right.cross(view).normalized()
        basis = np.array([right[:], up[:]]).T
        projected = np.array(reference) @ basis
        low, high = projected.min(axis=0), projected.max(axis=0)
        projections.append((basis, low, (size - 4) / max(high - low)))
        areas.append(float(np.prod(high - low) * ((size - 4) / max(high - low)) ** 2))

    bases = np.stack([basis for basis, _, _ in projections])
    origins = np.stack([low for _, low, _ in projections])
    scales = np.array([factor for _, _, factor in projections])

    def pixels(points):
        polygon = (np.einsum("ij,vjk->vik", np.array(points), bases) - origins[:, None, :])
        polygon = polygon * scales[:, None, None] + 2
        lo = np.maximum(0, np.floor(polygon.min(axis=1)).astype(int))
        hi = np.minimum(size - 1, np.ceil(polygon.max(axis=1)).astype(int))
        width, height = np.max(hi - lo + 1, axis=0)
        x = lo[:, 0, None, None] + np.arange(width)[None, None, :] + 0.5
        y = lo[:, 1, None, None] + np.arange(height)[None, :, None] + 0.5
        mask = np.zeros((len(projections), height, width), bool)
        for face in ((0, 3, 2), (0, 2, 1), (0, 5, 4), (0, 4, 3)):
            positive, negative = np.ones(mask.shape, bool), np.ones(mask.shape, bool)
            for ia, ib in zip(face, face[1:] + face[:1]):
                a, b = polygon[:, ia, :], polygon[:, ib, :]
                cross = ((b[:, 0] - a[:, 0])[:, None, None] * (y - a[:, 1, None, None])
                         - (b[:, 1] - a[:, 1])[:, None, None] * (x - a[:, 0, None, None]))
                positive &= cross >= 0
                negative &= cross <= 0
            mask |= positive | negative
        mask &= (x <= hi[:, 0, None, None] + 0.5) & (y <= hi[:, 1, None, None] + 0.5)
        masks = []
        for index in range(len(projections)):
            yy, xx = np.nonzero(mask[index])
            masks.append((yy + lo[index, 1]) * size + xx + lo[index, 0])
        return masks

    points = [[Vector(p) for p in leaves.vertices[i:i + 6]] for i in range(0, len(leaves.vertices), 6)]
    cached = [pixels(p) for p in points]
    counts = [np.zeros(size * size, np.int16) for _ in projections]
    for masks in cached:
        for buffer, indices in zip(counts, masks):
            buffer[indices] += 1
    for sweep in range(sweeps):
        coverage = np.array([np.count_nonzero(buffer) / area for buffer, area in zip(counts, areas)])
        weights = (coverage.max() / coverage) ** 4
        order = list(range(len(points)))
        rng.shuffle(order)
        for index in order:
            spec = specs[index]
            is_pinned = spec["pinned"]
            if is_pinned:
                continue
            old = points[index]
            midpoint = (old[0] + old[3]) * 0.5
            center, _ = groups[spec["group"]]
            outward = (midpoint - center).normalized()
            u, v = frame(outward)
            length = (old[3] - old[0]).length
            for buffer, indices in zip(counts, cached[index]):
                buffer[indices] -= 1
            best_masks, best_points = cached[index], old
            best_score = sum(weight * np.count_nonzero(buffer[indices] == 0)
                             for weight, buffer, indices in zip(weights, counts, best_masks))
            for _ in range(9):
                candidate = midpoint + (u * rng.uniform(-0.55, 0.55) + v * rng.uniform(-0.55, 0.55)) * length
                candidate += outward * rng.uniform(-0.025, 0.025)
                normal = (candidate - center).normalized()
                a, b = frame(normal)
                tilt = rng.uniform(0, math.radians(22))
                theta = rng.uniform(0, TAU)
                normal = normal * math.cos(tilt) + (a * math.cos(theta) + b * math.sin(theta)) * math.sin(tilt)
                moved = place_leaf(old, candidate, normal, rng.uniform(-0.7, 0.7))
                is_valid = valid_leaf_placement(moved, spec, groups)
                if not is_valid:
                    continue
                masks = pixels(moved)
                score = sum(weight * np.count_nonzero(buffer[indices] == 0)
                            for weight, buffer, indices in zip(weights, counts, masks))
                improved = score > best_score
                if improved:
                    best_score, best_masks, best_points = score, masks, moved
            points[index], cached[index] = best_points, best_masks
            for buffer, indices in zip(counts, best_masks):
                buffer[indices] += 1
        print(json.dumps({"event": "foliage_coverage_optimization", "pass": sweep + 1,
                          "leaf_count": len(points)}), flush=True)
    leaves.vertices = [tuple(p) for leaf in points for p in leaf]


def projected_leaf_coverage(leaves, reference):
    # The denominator is the union of approved clump outlines, including their notches.
    # Bark is excluded from the numerator so branches cannot inflate leaf coverage.
    size = 512
    scores = []
    offsets = [0] + [5.625 + index * 11.25 for index in range(16)]
    for offset in offsets:
        angle = math.atan2(-22, 11) + math.radians(offset)
        view = vec(math.cos(angle), math.sin(angle), 3 / math.hypot(11, 22)).normalized()
        right = view.cross(vec(0, 0, 1)).normalized()
        up = right.cross(view).normalized()
        basis = np.array([right[:], up[:]]).T
        old = np.array(reference) @ basis
        new = np.array(leaves.vertices) @ basis
        low, high = old.min(axis=0), old.max(axis=0)
        factor = (size - 4) / max(high - low)
        old, new = (old - low) * factor + 2, (new - low) * factor + 2
        outline, foliage = np.zeros((size, size), bool), np.zeros((size, size), bool)

        def raster(mask, polygon):
            lo = np.maximum(0, np.floor(polygon.min(axis=0)).astype(int))
            hi = np.minimum(size - 1, np.ceil(polygon.max(axis=0)).astype(int))
            x, y = np.meshgrid(np.arange(lo[0], hi[0] + 1) + 0.5,
                               np.arange(lo[1], hi[1] + 1) + 0.5)
            positive, negative = np.ones(x.shape, bool), np.ones(x.shape, bool)
            for a, b in zip(polygon, np.roll(polygon, -1, axis=0)):
                cross = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
                positive &= cross >= 0
                negative &= cross <= 0
            mask[lo[1]:hi[1] + 1, lo[0]:hi[0] + 1] |= positive | negative

        for patch in leaves.foliage_patches:
            points = sorted(set(map(tuple, old[patch["first"]:patch["stop"]])))
            halves = []
            for ordered in (points, reversed(points)):
                hull = []
                for point in ordered:
                    while len(hull) >= 2:
                        a, b = hull[-2:]
                        left_turn = (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]) > 0
                        if left_turn:
                            break
                        hull.pop()
                    hull.append(point)
                halves.extend(hull[:-1])
            raster(outline, np.array(halves))
        exterior = np.zeros((size, size), bool)
        exterior[0, 0] = True
        queue = deque([(0, 0)])
        while queue:
            x, y = queue.popleft()
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                in_image = 0 <= nx < size and 0 <= ny < size
                is_open = in_image and not outline[ny, nx] and not exterior[ny, nx]
                if is_open:
                    exterior[ny, nx] = True
                    queue.append((nx, ny))
        outline |= ~exterior
        for face in leaves.faces:
            raster(foliage, new[list(face)])
        scores.append(round(float(np.sum(outline & foliage) / np.sum(outline)), 4))
    return {"method": "leaf_triangles_over_hole_filled_union_of_approved_clump_projected_hulls",
            "resolution": size, "view_azimuth_offsets_degrees": offsets,
            "base_azimuth_degrees": math.degrees(math.atan2(-22, 11)),
            "elevation_degrees": math.degrees(math.atan2(3, math.hypot(11, 22))),
            "fractions": scores, "minimum": min(scores)}


def keyaki():
    rng, proxy_rng = random.Random(27243), random.Random(2302)
    builders = tuple(MeshBuilder() for _ in range(4))
    wood, leaves, low_wood, low_leaves = builders
    tone = (0.40, 0.405, 0.39)
    trunk = [vec(0, 0, 0), vec(0.04, -0.025, 0.5), vec(-0.08, 0.03, 1.7),
             vec(0.04, 0.09, 2.6), vec(0.10, 0.04, 3.45)]
    radii = [0.48, 0.36, 0.285, 0.22, 0.075]
    wood.tube(trunk, radii, 8, tone)
    low_wood.tube(trunk, radii, 5, tone)
    add_roots(wood, low_wood, rng, 0.43, tone)
    groups, anchors = [], []
    for branch in range(5):
        angle = TAU * branch / 5 + 0.24 + rng.uniform(-0.13, 0.13)
        radial = vec(math.cos(angle), math.sin(angle), 0)
        origin = vec(0.04, 0.06, 2.75 + branch * 0.06)
        end = radial * (2.10 + 0.10 * (branch % 3)) + vec(0, 0, 7.13 + 0.13 * (branch % 2))
        path = curved(origin, end, radial * 0.15 + vec(0, 0, 0.12), 3)
        wood.tube(path, [0.185, 0.135, 0.075, 0.024], 5, tone)
        low_wood.tube([path[0], path[1], path[3]], [0.185, 0.135, 0.024], 3, tone)
        for tier, (reach, z, radius, count) in enumerate((
            (0.87, 4.66, (0.75, 0.70, 0.84), 15),
            (1.50, 5.94, (1.02, 0.97, 1.06), 24),
            (2.03, 7.31, (1.13, 1.04, 0.98), 34),
        )):
            center = radial * (reach + 0.06 * (branch % 3))
            center.z = z + 0.13 * math.sin(branch * 2.1 + tier)
            groups.append((tuple(center), radius, count))
            anchors.append(origin.lerp(end, (center.z - origin.z) / (end.z - origin.z)))
    groups.append(((0.12, 0.03, 7.75), (1.17, 1.11, 0.85), 27))
    anchors.append(vec(0.20, 0.10, 6.60))
    wood.tube([trunk[-1], anchors[-1]], [0.072, 0.018], 4, tone)
    for index, group in enumerate(groups):
        branch_crown(builders, "keyaki", group, index, rng, proxy_rng, tone,
                     groups, anchors[index])
    normalize_broadleaf(builders, 8.65)
    for builder in builders:
        builder.vertices = [(x * 1.04, y, z) for x, y, z in builder.vertices]
    return builders


def kusu():
    rng, proxy_rng = random.Random(29207), random.Random(2905)
    builders = tuple(MeshBuilder() for _ in range(4))
    wood, leaves, low_wood, low_leaves = builders
    tone = (0.31, 0.255, 0.205)
    trunk = [vec(0, 0, 0), vec(0.07, -0.045, 0.45), vec(0.12, 0.035, 1.1),
             vec(0.01, 0.13, 1.8), vec(-0.07, 0.10, 2.5), vec(-0.10, 0.12, 2.9)]
    radii = [0.69, 0.56, 0.47, 0.35, 0.21, 0.045]
    wood.tube(trunk, radii, 10, tone)
    low_wood.tube(trunk[::2] + trunk[-1:], [0.69, 0.47, 0.21, 0.045], 6, tone)
    add_roots(wood, low_wood, rng, 0.61, tone)
    # Low lateral limbs and differently sized upper crowns produce a heavy dome.
    groups = [
        ((-2.25, -0.60, 3.67), (1.66, 1.36, 1.32), 56),
        ((1.84, -1.00, 4.05), (1.66, 1.52, 1.47), 54),
        ((-0.43, -2.02, 4.77), (1.46, 1.13, 1.38), 44),
        ((-1.39, 1.69, 4.25), (1.79, 1.39, 1.24), 50),
        ((2.06, 1.35, 4.74), (1.55, 1.27, 1.48), 52),
        ((-1.16, 0.10, 6.09), (1.46, 1.37, 1.12), 49),
        ((1.23, -0.25, 6.03), (1.43, 1.28, 1.21), 41),
        ((0.34, 1.48, 6.07), (1.10, 1.07, 0.96), 42),
    ]
    for index, group in enumerate(groups):
        branch_crown(builders, "kusu", group, index, rng, proxy_rng, tone, groups)
    return normalize_broadleaf(builders, 7.7)


def needle_tuft(mesh, center, direction, rng, height, radius):
    axis = direction.normalized()
    u, v = frame(axis)
    tone = leaf_color(rng, center, height, radius, conifer=True)
    length = rng.uniform(0.31, 0.43)
    for index in range(15):
        fraction = (index + 0.5) / 15
        angle = index * 2.399963 + rng.uniform(-0.20, 0.20)
        outward = u * math.cos(angle) + v * math.sin(angle)
        base = center + axis * length * fraction
        needle_axis = (axis * 0.70 + outward * 0.72).normalized()
        needle_length = rng.uniform(0.21, 0.31) * (1 - 0.36 * fraction)
        tip = base + needle_axis * needle_length
        side = axis.cross(outward).normalized() * needle_length * rng.uniform(0.18, 0.24)
        mesh.add([base - side, base + side, tip], [(0, 1, 2)],
                 [(*[c * shade for c in tone], 1) for shade in (0.65, 0.85, 1.15)])


def conifer():
    rng, proxy_rng = random.Random(26411), random.Random(2721)
    wood, leaves, low_wood, low_leaves = [MeshBuilder() for _ in range(4)]
    height, radius = 10.6, 1.45
    tone = (0.34, 0.145, 0.078)
    trunk = [vec(0, 0, z) for z in (0, 0.5, 2.4, 4.4, 6.5, 8.5, 10.1)]
    radii = [0.39, 0.27, 0.145, 0.075, 0.042, 0.02, 0.004]
    wood.tube(trunk, radii, 8, tone)
    low_wood.tube(trunk, radii, 5, tone)
    add_roots(wood, low_wood, rng, 0.35, tone)
    for branch_index in range(46):
        fraction = (branch_index + 0.5) / 46
        angle = branch_index * 2.399963 + rng.uniform(-0.19, 0.19)
        radial = vec(math.cos(angle), math.sin(angle), 0)
        tangent = vec(-math.sin(angle), math.cos(angle), 0)
        z = 3.12 + fraction * 6.93 + rng.uniform(-0.10, 0.10)
        reach = radius * (1 - fraction) ** 0.82 * rng.uniform(0.88, 1.12)
        base = vec(0, 0, z + 0.18)
        end = radial * reach + vec(0, 0, z)
        path = curved(base, end, vec(0, 0, 0.06), 2)
        wood.tube(path, [0.048 * (1 - fraction) + 0.007, 0.022, 0.004], 3, tone)
        first_vertex = len(leaves.vertices)
        for twig_index in range(3):
            twig_base = base.lerp(end, 0.32 + twig_index * 0.25)
            twig_end = twig_base + tangent * (twig_index - 1) * 0.21 + radial * 0.15 - vec(0, 0, 0.14)
            twig_ribbon(wood, twig_base, twig_end, tone)
            for shoot in range(5):
                theta = TAU * shoot / 5 + branch_index * 0.71
                spread = 0.16 + 0.14 * (1 - fraction)
                center = twig_end + tangent * math.cos(theta) * spread
                center += radial * math.sin(theta) * spread * 0.6 + vec(0, 0, (shoot - 2) * 0.15)
                center += vec(0, 0, rng.uniform(-0.08, 0.08))
                direction = radial * 0.74 + tangent * math.cos(theta) * 0.43 + vec(0, 0, rng.uniform(-0.31, 0.13))
                needle_tuft(leaves, center, direction, rng, height, radius)
        patch = MeshBuilder()
        patch.vertices = leaves.vertices[first_vertex:]
        proxy = MeshBuilder()
        bumpy_blob(proxy, bounds_of(patch.vertices),
                   leaf_color(proxy_rng, end, height, radius, True), proxy_rng, sides=6, rings=3)
        fit_proxy_bounds(patch, proxy)
        low_leaves.add(proxy.vertices, proxy.faces, proxy.colors)
    # Overlapping inner tufts mask the leader without a solid LOD0 foliage core.
    for index in range(44):
        ring = index // 4
        angle = (index % 4) * TAU / 4 + ring * 0.67
        radial = vec(math.cos(angle), math.sin(angle), 0)
        axis = (radial * 0.35 + vec(0, 0, 1)).normalized()
        center = radial * 0.10 + vec(0, 0, 2.92 + ring * 0.62)
        needle_tuft(leaves, center, axis, rng, height, radius)
    first_vertex = len(leaves.vertices)
    needle_tuft(leaves, vec(0, 0, 10.05), vec(0, 0, 1), rng, height, radius)
    bumpy_blob(low_leaves, bounds_of(leaves.vertices[first_vertex:]), (0.05, 0.17, 0.12),
               proxy_rng, sides=6, rings=3)
    fit_proxy_bounds(leaves, low_leaves)
    return normalize_tree((wood, leaves, low_wood, low_leaves), height)


def normalize_tree(builders, height):
    for pair in (builders[:2], builders[2:]):
        max_z = max(v[2] for builder in pair for v in builder.vertices)
        for builder in pair:
            builder.vertices = [(x, y, max(0, z) * height / max_z) for x, y, z in builder.vertices]
    return builders


def node_statistics(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    low, high = bounds_of(mesh.vertices[i].co for i in range(len(mesh.vertices)))
    return {
        "triangles": len(mesh.loop_triangles), "vertices": len(mesh.vertices),
        "bounds_gltf": {"min": [round(low.x, 5), round(low.z, 5), round(-high.y, 5)],
                        "max": [round(high.x, 5), round(high.z, 5), round(-low.y, 5)]},
    }


def read_glb(path):
    data = path.read_bytes()
    magic, version, total = struct.unpack_from("<4sII", data)
    assert magic == b"glTF" and version == 2 and total == len(data)
    length, chunk_type = struct.unpack_from("<II", data, 12)
    assert chunk_type == 0x4E4F534A
    return json.loads(data[20:20 + length])


def validate_glb(path, objects):
    document = read_glb(path)
    raw = path.read_bytes()
    json_length = struct.unpack_from("<I", raw, 12)[0]
    binary_offset = 28 + json_length
    assert len(document["nodes"]) == 12
    assert {node["name"] for node in document["nodes"]} == {obj.name for obj in objects}
    assert {material["name"] for material in document["materials"]} == {"Bark", "Leaves"}
    assert not any(document.get(key) for key in ("textures", "images", "animations", "cameras", "extensionsUsed"))
    exported = {}
    for node in document["nodes"]:
        assert node.get("translation", [0, 0, 0]) == [0, 0, 0]
        assert "rotation" not in node and "scale" not in node
        mesh = document["meshes"][node["mesh"]]
        counts = {"vertices": 0, "triangles": 0}
        for primitive in mesh["primitives"]:
            assert "COLOR_0" in primitive["attributes"]
            assert "NORMAL" in primitive["attributes"]
            color_accessor = document["accessors"][primitive["attributes"]["COLOR_0"]]
            color_view = document["bufferViews"][color_accessor["bufferView"]]
            color_start = binary_offset + color_view.get("byteOffset", 0) + color_accessor.get("byteOffset", 0)
            assert color_accessor["componentType"] in (5121, 5123) and color_accessor["normalized"]
            color_format = "4B" if color_accessor["componentType"] == 5121 else "4H"
            stride = struct.calcsize("<" + color_format)
            colors = {struct.unpack_from("<" + color_format, raw, color_start + index * stride)[:3] for index in range(color_accessor["count"])}
            assert len(colors) > 8
            material = document["materials"][primitive["material"]]
            assert "baseColorFactor" in material["pbrMetallicRoughness"]
            assert "TEXCOORD_0" not in primitive["attributes"]
            counts["vertices"] += document["accessors"][primitive["attributes"]["POSITION"]]["count"]
            counts["triangles"] += document["accessors"][primitive["indices"]]["count"] // 3
        exported[node["name"]] = counts
    assert path.stat().st_size <= 3_000_000, "GLB exceeds 3 MB"
    return exported


def point_at(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat("-Z", "Y").to_euler()


def render_previews(objects, directory):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 32
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("PreviewSky")
    world.use_nodes = True
    world_nodes = world.node_tree.nodes
    ambient = world_nodes["Background"]
    ambient.inputs["Color"].default_value = (0.72, 0.79, 0.88, 1)
    ambient.inputs["Strength"].default_value = 0.35
    sky = world_nodes.new("ShaderNodeBackground")
    sky.inputs["Color"].default_value = (0.22, 0.52, 0.85, 1)
    sky.inputs["Strength"].default_value = 0.8
    light_path = world_nodes.new("ShaderNodeLightPath")
    mix = world_nodes.new("ShaderNodeMixShader")
    world.node_tree.links.new(light_path.outputs["Is Camera Ray"], mix.inputs[0])
    world.node_tree.links.new(ambient.outputs[0], mix.inputs[1])
    world.node_tree.links.new(sky.outputs[0], mix.inputs[2])
    world.node_tree.links.new(mix.outputs[0], world_nodes["World Output"].inputs["Surface"])
    scene.world = world
    light_data = bpy.data.lights.new("PreviewSun", "SUN")
    light_data.energy = 4.5
    light_data.angle = math.radians(15)
    light = bpy.data.objects.new("PreviewSun", light_data)
    scene.collection.objects.link(light)
    light.rotation_euler = (math.radians(26), math.radians(-32), math.radians(-25))
    camera_data = bpy.data.cameras.new("PreviewCamera")
    camera = bpy.data.objects.new("PreviewCamera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera

    def render(filename):
        scene.render.filepath = str(directory / filename)
        bpy.ops.render.render(write_still=True)

    for kind in ("keyaki", "kusu", "sugi"):
        active = [obj for obj in objects if obj.name.startswith(kind + "_LOD0")]
        low, high = bounds_of([obj.matrix_world @ Vector(corner) for obj in active for corner in obj.bound_box])
        height = high.z
        width = max(high.x - low.x, high.y - low.y)
        camera_data.type = "ORTHO"
        camera_data.ortho_scale = max(height, width) * 1.16
        target = vec(0, 0, height * 0.50)
        camera.location = target + vec(11, -22, 3.0)
        point_at(camera, target)
        for lod in (0, 1):
            for obj in objects:
                obj.hide_render = not obj.name.startswith(f"{kind}_LOD{lod}_")
            render(f"{kind}_lod{lod}.png")
        for obj in objects:
            obj.hide_render = obj not in active
        light.rotation_euler = vec(11, -22, -9).to_track_quat("-Z", "Y").to_euler()
        render(f"{kind}_backlit.png")
        light.rotation_euler = (math.radians(26), math.radians(-32), math.radians(-25))
        camera_data.type = "PERSP"
        camera_data.lens = 80
        framing = {"keyaki": (0.55, 0.65, 0.79), "kusu": (0.42, 0.75, 0.75),
                   "sugi": (0.25, 0.50, 0.55)}[kind]
        target = vec(high.x * framing[0], low.y * framing[1], height * framing[2])
        camera.location = target + vec(1, -5.0, 0.7)
        point_at(camera, target)
        render(f"{kind}_closeup.png")
    for obj in objects:
        obj.hide_render = "_LOD1_" in obj.name
        obj.location.x = {"keyaki": -9.4, "kusu": 0, "sugi": 8.0}[obj.name.split("_")[0]]
    camera_data.type = "ORTHO"
    bpy.context.view_layer.update()
    low, high = bounds_of([obj.matrix_world @ Vector(corner) for obj in objects
                           if not obj.hide_render for corner in obj.bound_box])
    camera_data.ortho_scale = (high.x - low.x) * 1.12
    center_x = (high.x + low.x) * 0.5
    camera.location = vec(center_x, -35, 10)
    point_at(camera, vec(center_x, 0, 4.8))
    render("lineup.png")
    for obj in objects:
        obj.location = (0, 0, 0)
        obj.hide_render = False


def main():
    start = time.monotonic()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "packages/web/public/models/trees.glb")
    parser.add_argument("--preview-dir", type=Path, default=DEFAULT_PREVIEW)
    parser.add_argument("--skip-previews", action="store_true")
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    args = parser.parse_args(arguments)
    args.preview_dir.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for material in list(bpy.data.materials):
        bpy.data.materials.remove(material)
    bark = make_material("Bark", (0.85, 0.82, 0.78))
    foliage = make_material("Leaves", (0.92, 1.0, 0.88))
    objects = []
    stats = {"seed_version": 5, "coordinate_system": "+Y up (glTF)", "nodes": {}, "trees": {}}
    for kind in ("keyaki", "kusu", "sugi"):
        builders = {"keyaki": keyaki, "kusu": kusu, "sugi": conifer}[kind]()
        is_broadleaf = kind != "sugi"
        foliage_stats = refine_broadleaf_foliage(builders, kind) if is_broadleaf else {}
        for builder, suffix, material in zip(builders, ("LOD0_trunk", "LOD0_leaves", "LOD1_trunk", "LOD1_leaves"), (bark, foliage, bark, foliage)):
            obj = builder.object(f"{kind}_{suffix}", material)
            objects.append(obj)
            stats["nodes"][obj.name] = node_statistics(obj)
        low, high = bounds_of(builders[0].vertices + builders[1].vertices)
        crown_low, crown_high = bounds_of(builders[1].vertices)
        stats["trees"][kind] = {
            "generator": {"keyaki": "keyaki_five_broom_scaffolds_three_tiers_v4", "kusu": "kusu_eight_exposed_dome_shells_v4", "sugi": "sugi_overlapping_bough_tufts_v3"}[kind],
            "foliage_clump_count": {"keyaki": 16, "kusu": 8, "sugi": 47}[kind],
            "crown_base_height": round(crown_low.z, 5),
            "crown_height": round(crown_high.z - crown_low.z, 5),
            "leaf_count": len(builders[1].vertices) // (3 if kind == "sugi" else 6),
            "leaf_count_unit": "individual_needles" if kind == "sugi" else "individual_broad_leaves",
            "height": round(high.z - low.z, 5),
            "crown_width_x": round(crown_high.x - crown_low.x, 5),
            "crown_width_z": round(crown_high.y - crown_low.y, 5),
            "crown_bounds_gltf": stats["nodes"][f"{kind}_LOD0_leaves"]["bounds_gltf"],
            "crown_depth_z": round(crown_high.y - crown_low.y, 5),
            "crown_height_y": round(crown_high.z - crown_low.z, 5),
            "crown_bottom_y": round(crown_low.z, 5),
            "lod1_crown_bounds_gltf": stats["nodes"][f"{kind}_LOD1_leaves"]["bounds_gltf"],
        }
        assert stats["nodes"][f"{kind}_LOD0_trunk"]["triangles"] <= 2000
        is_broadleaf = kind != "sugi"
        if is_broadleaf:
            stats["trees"][kind]["lod1_clump_scale"] = 0.88
            stats["trees"][kind]["foliage_distribution"] = "70_percent_outer_shell_30_percent_inner"
            stats["trees"][kind].update(foliage_stats)
            leaf_vertices = builders[1].vertices
            lengths = [(Vector(leaf_vertices[i + 3]) - Vector(leaf_vertices[i])).length
                       for i in range(0, len(leaf_vertices), 6)]
            lower_limit, upper_limit = (0.19 - 1e-6, 0.21 + 1e-6) if kind == "keyaki" else (0.25 - 1e-6, 0.28 + 1e-6)
            assert min(lengths) >= lower_limit and max(lengths) <= upper_limit, (kind, min(lengths), max(lengths))
            stats["trees"][kind]["leaf_count"] = len(lengths)
            stats["trees"][kind]["rosette_count"] = len(lengths) // 7
            stats["trees"][kind]["leaves_per_rosette"] = 7
            stats["trees"][kind]["leaf_length_range"] = [round(min(lengths), 5), round(max(lengths), 5)]
        for lod, limit in ((0, 12000), (1, 1500)):
            triangles = sum(stats["nodes"][f"{kind}_LOD{lod}_{part}"]["triangles"] for part in ("trunk", "leaves"))
            stats["trees"][kind][f"LOD{lod}_triangles"] = triangles
            assert triangles <= limit, f"{kind} LOD{lod}: {triangles} > {limit}"
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(args.output), export_format="GLB", use_selection=True,
        export_yup=True, export_texcoords=False, export_normals=True,
        export_materials="EXPORT", export_attributes=False,
        export_vertex_color="NAME", export_vertex_color_name="COLOR_0",
        export_all_vertex_colors=False,
        export_animations=False, export_cameras=False, export_lights=False,
        export_draco_mesh_compression_enable=False,
    )
    stats["exported_nodes"] = validate_glb(args.output, objects)
    stats["glb_bytes"] = args.output.stat().st_size
    stats["glb_sha256"] = hashlib.sha256(args.output.read_bytes()).hexdigest()
    stats["geometry_export_seconds"] = round(time.monotonic() - start, 3)
    should_render = not args.skip_previews
    if should_render:
        render_previews(objects, args.preview_dir)
    stats["previews_rendered"] = not args.skip_previews
    stats["preview_settings"] = {
        "engine": "Cycles", "device": "CPU", "samples": 32,
        "resolution": [640, 640], "count": 13 if should_render else 0,
        "views": ["lod0", "lod1", "closeup", "backlit", "lineup"],
    }
    stats["elapsed_seconds"] = round(time.monotonic() - start, 3)
    stats["blender_version"] = bpy.app.version_string
    output = json.dumps(stats, ensure_ascii=False, indent=2)
    (args.preview_dir / "stats.json").write_text(output + "\n")
    print(output, flush=True)


is_main = __name__ == "__main__"
if is_main:
    main()
