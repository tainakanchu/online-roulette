# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic course props; run with Blender -b --factory-startup -noaudio.

All construction coordinates are game coordinates: X along track, Y up,
Z toward track. Blender stores (X, -Z, Y), exported glTF restores (X, Y, Z).
UVs below use artist convention (V up); glTF stores V down for image sampling.
StarterFlag has a top/hoist pivot, and attaches at StarterStand.flag_attachment.
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


# プレビュー画像と統計の出力先。環境変数 BLENDER_PREVIEW_DIR で変えられる（既定は OS の一時フォルダー）
PREVIEW_DIR = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "course"
NAMES = ("PaintWhite", "PaintRed", "SteelGrey", "Dark", "Glass", "SignFace", "FlagCloth", "Canvas", "Tire")
BUDGETS = dict(FurlongPole=600, FinishPost=3000, PatrolTower=4000, StarterStand=3500, StarterFlag=100, CameraPlatform=3000)
FLAG_ATTACHMENT = (0.67, 4.18, 0.53)


def native(p):
    return Vector((p[0], -p[2], p[1]))


def game(p):
    return (p[0], p[2], -p[1])


def material(name, rgb, metal=0.0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*rgb, 1)
    shader.inputs["Roughness"].default_value = 0.55
    shader.inputs["Metallic"].default_value = metal
    mat.use_backface_culling = name != "FlagCloth"
    is_glass = name == "Glass"
    if is_glass:
        shader.inputs["Roughness"].default_value = 0.18
        shader.inputs["Metallic"].default_value = 0.3
    is_tire = name == "Tire"
    if is_tire:
        shader.inputs["Roughness"].default_value = 0.86
    return mat


class Mesh:
    def __init__(self):
        self.vertices, self.faces, self.mats, self.uvs, self.smooth = [], [], [], [], []

    def add(self, vertices, faces, mat, uv=None, smooth=False):
        offset = len(self.vertices)
        self.vertices.extend(vertices)
        for face in faces:
            self.faces.append(tuple(offset + i for i in face))
            self.mats.append(NAMES.index(mat))
            self.smooth.append(smooth)
            self.uvs.append([uv(vertices[i]) for i in face] if uv else [(0, 0)] * len(face))

    def box(self, c, s, mat):
        vertices = [(c[0] + x*s[0]/2, c[1] + y*s[1]/2, c[2] + z*s[2]/2)
                    for x, y, z in ((-1,-1,-1), (1,-1,-1), (1,1,-1), (-1,1,-1),
                                    (-1,-1,1), (1,-1,1), (1,1,1), (-1,1,1))]
        self.add(vertices, [(3,2,1,0), (4,5,6,7), (0,1,5,4), (1,2,6,5), (2,3,7,6), (3,0,4,7)], mat)

    def pipe(self, start, end, radius, mat, sides=6):
        a, b = Vector(start), Vector(end)
        axis = (b-a).normalized()
        ref = Vector((0,1,0))
        is_vertical = abs(axis.dot(ref)) > 0.95
        if is_vertical:
            ref = Vector((1,0,0))
        u = axis.cross(ref).normalized()
        v = axis.cross(u)
        vertices = [tuple(p + radius*(u*math.cos(i*math.tau/sides) + v*math.sin(i*math.tau/sides)))
                    for p in (a,b) for i in range(sides)]
        self.add(vertices, [(i,(i+1)%sides,(i+1)%sides+sides,i+sides) for i in range(sides)], mat, smooth=True)
        self.add(vertices, [tuple(reversed(range(sides))), tuple(range(sides,2*sides))], mat)

    def panel(self, outline, depth, uv):
        n = len(outline)
        vertices = [(x,y,z) for z in (-depth/2,depth/2) for x,y in outline]
        self.add(vertices, [tuple(reversed(range(n)))], "PaintWhite")
        self.add(vertices, [tuple(range(n,2*n))], "SignFace", uv)
        self.add(vertices, [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)], "PaintWhite")

    def finish(self, name, materials):
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([native(p) for p in self.vertices], [], self.faces)
        for mat in materials:
            mesh.materials.append(mat)
        uv_layer = mesh.uv_layers.new(name="UVMap")
        for face, mat, uvs, smooth in zip(mesh.polygons, self.mats, self.uvs, self.smooth):
            face.material_index = mat
            face.use_smooth = smooth
            for loop, uv in zip(face.loop_indices, uvs):
                uv_layer.data[loop].uv = uv
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        obj["coordinate_system"] = "+X running, +Y up, +Z track/front"
        return obj


def furlong(materials):
    m = Mesh()
    m.box((0,0.045,0), (0.42,0.09,0.42), "SteelGrey")
    for i in range(8):
        m.pipe((0,0.09+i*0.36375,0), (0,0.09+(i+1)*0.36375,0), 0.09,
               "PaintWhite" if i%2 else "PaintRed", 10)
    # Separate planar white discs keep the red rim independent of numeric art.
    count, cy = 24, 3.16
    for side in (-1,1):
        verts = [(r*math.cos(i*math.tau/count), cy+r*math.sin(i*math.tau/count), side*0.111)
                 for r in (0.365,0.45) for i in range(count)]
        faces = [(i,i+count,(i+1)%count+count,(i+1)%count) for i in range(count)]
        faces = faces if side == 1 else [tuple(reversed(f)) for f in faces]
        m.add(verts, faces, "PaintRed")
        face = tuple(range(count)) if side == 1 else tuple(reversed(range(count)))
        m.add(verts[:count], [face], "SignFace", lambda p, s=side: (0.5+s*p[0]/0.73, 0.5+(p[1]-cy)/0.73))
    m.pipe((0,cy,-0.11), (0,cy,0.11), 0.45, "PaintRed", 24)
    return m.finish("FurlongPole", materials)


def finish_post(materials):
    m = Mesh()
    m.box((0,0.15,0), (3.12,0.3,0.68), "SteelGrey")
    m.box((0,0.68,0), (2.98,0.76,0.53), "PaintWhite")
    m.box((0,0.98,0), (3.1,0.12,0.6), "Dark")
    def top(x):
        return 4.65 + 1.5*math.sqrt(max(0,1-(x/1.5)**2))
    uv = lambda p: ((p[0]+1.5)/3, (p[1]-1.04)/(6.15-1.04))
    for left, right in ((-1.5,-0.12),(0.12,1.5)):
        xs = [right+(left-right)*i/16 for i in range(17)]
        outline = [(left,1.04),(right,1.04)] + [(x,top(x)) for x in xs]
        m.panel(outline,0.25,uv)
        for a,b in zip(outline, outline[1:]+outline[:1]):
            is_inner_edge = abs(abs(a[0])-0.12) < 1e-6 and abs(a[0]-b[0]) < 1e-6
            if is_inner_edge:
                a,b = (a[0],min(a[1],5.54)),(b[0],min(b[1],5.54))
            m.pipe((a[0],a[1],0.14), (b[0],b[1],0.14),0.026,"PaintWhite",6)
    m.panel([(-0.12,5.54),(0.12,5.54),(0.12,top(0.12)),(0,6.15),(-0.12,top(-0.12))],0.25,uv)
    m.pipe((0,1.04,0.02),(0,5.54,0.02),0.035,"Dark",8)
    for x in (-0.67,0.67):
        y = top(x)
        m.pipe((x,y,0),(x,y+0.16,0),0.035,"SteelGrey")
        m.box((x,y+0.24,0.035),(0.25,0.16,0.22),"Dark")
        m.box((x,y+0.24,0.151),(0.18,0.09,0.018),"PaintWhite")
    return m.finish("FinishPost", materials)


def ladder(m, x, y0, y1, z, width=0.45):
    for dx in (-width/2,width/2):
        m.pipe((x+dx,y0,z),(x+dx,y1+0.5,z),0.027,"SteelGrey")
    for i in range(math.floor((y1-y0)/0.3)+1):
        y = y0+0.3*i
        m.pipe((x-width/2,y,z),(x+width/2,y,z),0.022,"SteelGrey")


def railing(m, a, b, height=0.85, mat="PaintWhite"):
    for p in (a,b):
        m.pipe(p,(p[0],p[1]+height,p[2]),0.032,mat)
    for dy in (height*0.48,height):
        m.pipe((a[0],a[1]+dy,a[2]),(b[0],b[1]+dy,b[2]),0.027,mat)


def patrol(materials):
    m = Mesh()
    for x in (-0.8,0.8):
        for z in (-0.8,0.8):
            m.box((x,0.12,z),(0.45,0.24,0.45),"SteelGrey")
            m.pipe((x,0.24,z),(x*0.7,11.85,z*0.7),0.067,"PaintWhite",8)
    for level in range(6):
        y0,y1 = 0.25+level*1.9,0.25+(level+1)*1.9
        r0,r1 = 0.8-0.24*y0/11.85,0.8-0.24*y1/11.85
        for side in (-1,1):
            m.pipe((-r0,y0,side*r0),(r1,y1,side*r1),0.028,"SteelGrey")
            m.pipe((r0,y0,side*r0),(-r1,y1,side*r1),0.028,"SteelGrey")
            m.pipe((side*r0,y0,-r0),(side*r1,y1,r1),0.028,"SteelGrey")
            m.pipe((-r1,y1,side*r1),(r1,y1,side*r1),0.035,"PaintWhite")
            m.pipe((side*r1,y1,-r1),(side*r1,y1,r1),0.035,"PaintWhite")
    for y in (5.95,11.85):
        m.box((0,y,0),(1.8,0.12,1.8),"SteelGrey")
    for z in (-0.86,0.86):
        railing(m,(-0.86,6.01,z),(0.86,6.01,z))
    railing(m,(-0.86,6.01,-0.86),(-0.86,6.01,0.86))
    ladder(m,0,0.26,5.95,0.88)
    ladder(m,0,6.04,11.85,-0.69)
    m.box((0,12.1,0),(1.62,0.38,1.62),"PaintWhite")
    m.box((0,12.84,0),(1.50,1.08,1.50),"Glass")
    for x in (-0.8,0,0.8):
        for z in (-0.8,0.8):
            m.box((x,12.82,z),(0.065,1.32,0.065),"PaintWhite")
    for y in (12.28,13.4):
        m.box((0,y,0),(1.68,0.09,1.68),"PaintWhite")
    m.box((0,13.52,0),(1.98,0.16,1.98),"PaintWhite")
    m.pipe((0.45,13.6,0),(0.45,14.04,0),0.018,"Dark")
    return m.finish("PatrolTower",materials)


def trailer_wheel(m, x, z):
    sides = 16
    profile = ((-0.12,0.17),(-0.15,0.26),(-0.10,0.35),
               (0.10,0.35),(0.15,0.26),(0.12,0.17))
    vertices = [(x+offset,0.35+radius*math.cos(i*math.tau/sides),
                 z+radius*math.sin(i*math.tau/sides))
                for offset,radius in profile for i in range(sides)]
    faces = [(j*sides+i,j*sides+(i+1)%sides,
              ((j+1)%len(profile))*sides+(i+1)%sides,
              ((j+1)%len(profile))*sides+i)
             for j in range(len(profile)) for i in range(sides)]
    m.add(vertices,faces,"Tire",smooth=True)
    m.pipe((x-0.13,0.35,z),(x+0.13,0.35,z),0.183,"SteelGrey",16)
    m.pipe((x-0.175,0.35,z),(x+0.175,0.35,z),0.066,"SteelGrey",8)
    outside = 1 if x > 0 else -1
    for i in range(4):
        angle = i*math.tau/4
        y,dz = 0.35+0.115*math.cos(angle),z+0.115*math.sin(angle)
        m.pipe((x+outside*0.13,y,dz),(x+outside*0.149,y,dz),0.018,"SteelGrey",6)


def trailer_frame(m):
    for x in (-0.7,0.7):
        m.box((x,0.5,0.95),(0.13,0.16,1.78),"SteelGrey")
    for z in (0.12,0.36,1.52,1.78):
        m.box((0,0.5,z),(1.4,0.16,0.13),"SteelGrey")
    for z in (0.36,1.52):
        m.pipe((-1.0,0.35,z),(1.0,0.35,z),0.06,"SteelGrey",8)
        for x in (-1.0,1.0):
            trailer_wheel(m,x,z)
    for x in (-0.7,0.7):
        for z in (0.12,1.78):
            m.pipe((x,0.28,z),(x,0.64,z),0.052,"SteelGrey",8)
            m.pipe((x,0.05,z),(x,0.35,z),0.028,"SteelGrey",8)
            m.box((x,0.025,z),(0.20,0.05,0.20),"SteelGrey")
            m.pipe((x-0.09,0.66,z),(x+0.09,0.66,z),0.018,"SteelGrey")
        # The +Z drawbar leaves the existing -Z stair entrance unobstructed.
        m.pipe((x,0.5,1.78),(0,0.4,2.91),0.055,"SteelGrey",8)
    m.box((0,0.46,2.23),(0.83,0.07,0.10),"SteelGrey")
    segments,sides = 16,6
    vertices = [((0.15+0.035*math.cos(j*math.tau/sides))*math.cos(i*math.tau/segments),
                 0.4+0.035*math.sin(j*math.tau/sides),
                 3.05+(0.15+0.035*math.cos(j*math.tau/sides))*math.sin(i*math.tau/segments))
                for i in range(segments) for j in range(sides)]
    faces = [(i*sides+j,i*sides+(j+1)%sides,
              ((i+1)%segments)*sides+(j+1)%sides,((i+1)%segments)*sides+j)
             for i in range(segments) for j in range(sides)]
    m.add(vertices,faces,"SteelGrey",smooth=True)


def starter(materials):
    m = Mesh()
    trailer_frame(m)
    for x in (-0.7,0.7):
        for z in (0.25,1.65):
            m.pipe((x,0.58,z),(x,2.48,z),0.055,"SteelGrey")
        m.pipe((x,0.61,0.25),(x,2.43,1.65),0.034,"SteelGrey")
        m.pipe((x,0.61,1.65),(x,2.43,0.25),0.034,"SteelGrey")
    m.box((0,2.43,0.95),(1.56,0.14,1.56),"SteelGrey")
    for x in (-0.73,0.73):
        railing(m,(x,2.5,0.2),(x,2.5,1.68))
    railing(m,(-0.73,2.5,1.68),(0.73,2.5,1.68))
    for x in (-0.46,0.46):
        m.box((x,0.02,-1.68),(0.14,0.04,0.22),"SteelGrey")
        m.pipe((x,0.04,-1.68),(x,0.15,-1.68),0.035,"SteelGrey")
        m.pipe((x,0.15,-1.68),(x,2.43,0.23),0.055,"SteelGrey")
        m.pipe((x,0.15,-1.68),(x,1.05,-1.68),0.029,"PaintWhite")
        m.pipe((x,1.05,-1.68),(x,3.35,0.23),0.03,"PaintWhite")
    for i in range(10):
        m.box((0,0.25*(i+1)-0.04,-1.62+0.195*i),(0.94,0.08,0.24),"SteelGrey")
    m.pipe((0.67,2.5,0.53),(0.67,4.23,0.53),0.026,"PaintWhite",8)
    obj = m.finish("StarterStand",materials)
    obj["flag_attachment"] = FLAG_ATTACHMENT
    obj["platform_height"] = 2.5
    obj["trailer"] = {"wheel_count":4,"tire_diameter":0.7,"frame_center_y":0.5,
                      "coupling_center":[0,0.4,3.05],"jack_count":4,"jacks_deployed":True}
    return obj


def flag(materials):
    m = Mesh()
    vertices = [(0.9*x/8,-0.6*y/4,0) for y in range(5) for x in range(9)]
    faces = [(y*9+x,(y+1)*9+x,(y+1)*9+x+1,y*9+x+1) for y in range(4) for x in range(8)]
    m.add(vertices,faces,"FlagCloth",lambda p:(p[0]/0.9,1+p[1]/0.6))
    obj = m.finish("StarterFlag",materials)
    obj["attachment_to_StarterStand"] = FLAG_ATTACHMENT
    obj["pivot"] = "hoist top; local x=0 fixed, x=0.9 free; material doubleSided"
    return obj


def camera_platform(materials):
    m = Mesh()
    for x in (-0.9,0.9):
        for z in (-0.7,0.7):
            m.box((x,0.04,z),(0.25,0.08,0.25),"SteelGrey")
            m.pipe((x,0.08,z),(x,2.05,z),0.045,"SteelGrey")
        m.pipe((x,0.3,-0.7),(x,1.92,0.7),0.028,"SteelGrey")
        m.pipe((x,0.3,0.7),(x,1.92,-0.7),0.028,"SteelGrey")
    for z in (-0.7,0.7):
        m.pipe((-0.9,0.25,z),(0.9,1.92,z),0.03,"SteelGrey")
        m.pipe((0.9,0.25,z),(-0.9,1.92,z),0.03,"SteelGrey")
    m.box((0,1.94,0),(2.03,0.12,1.64),"SteelGrey")
    for x in (-0.96,0.96):
        railing(m,(x,2,-0.75),(x,2,0.75),0.65)
    railing(m,(-0.96,2,0.75),(0.96,2,0.75),0.65)
    ladder(m,-0.45,0.08,2,-0.84)
    for angle in (0,math.tau/3,2*math.tau/3):
        x,z = 0.25+0.48*math.cos(angle),0.17+0.48*math.sin(angle)
        m.pipe((x,2.01,z),(0.25,2.98,0.17),0.035,"Dark",8)
        m.pipe((x,2.01,z),(0.25,2.50,0.17),0.014,"SteelGrey")
    m.box((0.25,3.01,0.17),(0.23,0.16,0.23),"Dark")
    m.box((0.25,3.25,0.22),(0.38,0.36,0.72),"Dark")
    m.pipe((0.25,3.25,0.56),(0.25,3.25,0.88),0.13,"Dark",12)
    m.pipe((0.25,3.25,0.885),(0.25,3.25,0.90),0.102,"Glass",12)
    m.box((0.02,3.46,0.05),(0.13,0.12,0.26),"Dark")
    m.pipe((0.32,3.08,-0.12),(0.6,2.93,-0.43),0.024,"Dark")
    m.pipe((-0.56,2,-0.32),(-0.56,4.29,-0.32),0.026,"PaintWhite",8)
    n,cx,cz = 12,-0.56,-0.32
    vertices = [(cx,4.39,cz)] + [(cx+r*math.cos(i*math.tau/n),y,cz+r*math.sin(i*math.tau/n))
                                for r,y in ((0.48,4.20),(1.25,3.89),(1.25,3.79)) for i in range(n)]
    for i in range(n):
        j = (i+1)%n
        mat = "Canvas" if i%2 else "PaintWhite"
        m.add(vertices,[(0,1+j,1+i),(1+i,1+j,1+n+j,1+n+i),(1+n+i,1+n+j,1+2*n+j,1+2*n+i)],mat)
        m.pipe((cx,4.34,cz),vertices[1+n+i],0.014,"SteelGrey")
    return m.finish("CameraPlatform",materials)


def glb_data(path):
    data = path.read_bytes()
    json_length = struct.unpack_from("<I",data,12)[0]
    doc = json.loads(data[20:20+json_length])
    return doc,data[28+json_length:]


def accessor(doc, binary, index):
    a = doc["accessors"][index]
    view = doc["bufferViews"][a["bufferView"]]
    sizes = {"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4}
    fmt = {5126:"f",5125:"I",5123:"H",5121:"B"}[a["componentType"]]
    n = sizes[a["type"]]
    stride = view.get("byteStride",struct.calcsize(fmt)*n)
    start = view.get("byteOffset",0)+a.get("byteOffset",0)
    return [struct.unpack_from("<"+fmt*n,binary,start+i*stride) for i in range(a["count"])]


def node_fingerprints(path):
    doc,binary = glb_data(path)
    fingerprints = {}
    for node in doc["nodes"]:
        payload = {"node":{k:v for k,v in node.items() if k != "mesh"},"primitives":[]}
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            payload["primitives"].append({
                "attributes":{name:accessor(doc,binary,index) for name,index in primitive["attributes"].items()},
                "indices":accessor(doc,binary,primitive["indices"]),
                "material":doc["materials"][primitive["material"]],
                "mode":primitive.get("mode",4),
            })
        fingerprints[node["name"]] = hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()
    return fingerprints


def inspect(path):
    doc,binary = glb_data(path)
    assert len(doc["nodes"]) == len(doc["meshes"]) == 6
    assert not any(doc.get(k) for k in ("images","textures","cameras","animations","skins","extensionsUsed"))
    assert {m["name"] for m in doc["materials"]} == set(NAMES)
    stats = {}
    for node in doc["nodes"]:
        name = node["name"]
        assert not any(node.get(k) for k in ("translation","rotation","scale","matrix"))
        primitives = doc["meshes"][node["mesh"]]["primitives"]
        points,triangles,materials = [],0,[]
        for p in primitives:
            positions = accessor(doc,binary,p["attributes"]["POSITION"])
            points.extend(positions)
            triangles += doc["accessors"][p["indices"]]["count"]//3
            mat = doc["materials"][p["material"]]["name"]
            materials.append(mat)
            needs_uv = mat in ("SignFace","FlagCloth")
            if needs_uv:
                uv = accessor(doc,binary,p["attributes"]["TEXCOORD_0"])
                normals = accessor(doc,binary,p["attributes"]["NORMAL"])
                for pos,tex,normal in zip(positions,uv,normals):
                    x,y,z = pos
                    is_pole = name == "FurlongPole"
                    is_finish = name == "FinishPost"
                    if is_pole:
                        expected = (0.5+(1 if z>0 else -1)*x/0.73,0.5-(y-3.16)/0.73)
                        assert normal[2] * z > 0
                    elif is_finish:
                        assert z > 0
                        assert normal[2] > 0.99
                        expected = ((x+1.5)/3,1-(y-1.04)/5.11)
                    else:
                        expected = (x/0.9,-y/0.6)
                    assert max(abs(a-b) for a,b in zip(tex,expected)) < 0.00001,(name,pos,tex,expected)
                    assert all(-0.00001 <= v <= 1.00001 for v in tex)
                is_flag = mat == "FlagCloth"
                if is_flag:
                    assert doc["materials"][p["material"]]["doubleSided"]
        assert triangles <= BUDGETS[name],(name,triangles)
        is_grounded = name != "StarterFlag"
        if is_grounded:
            assert abs(min(p[1] for p in points)) < 0.00001
        stats[name] = {"triangles":triangles,"vertices":len(points),"bbox":{"min":[round(min(p[i] for p in points),5) for i in range(3)],"max":[round(max(p[i] for p in points),5) for i in range(3)]},"materials":materials}
    assert path.stat().st_size <= 800_000
    return stats


def point_camera(camera, position, target, scale):
    camera.location = native(position)
    camera.rotation_euler = (native(target)-camera.location).to_track_quat("-Z","Y").to_euler()
    camera.data.ortho_scale = scale


def text_object(body, position, size, mat):
    data = bpy.data.curves.new("PreviewText","FONT")
    data.body, data.size, data.align_x = body,size,"CENTER"
    obj = bpy.data.objects.new("PreviewText",data)
    bpy.context.collection.objects.link(obj)
    obj.location = native(position)
    obj.rotation_euler = native((0,0,1)).to_track_quat("Z","Y").to_euler()
    data.materials.append(mat)
    return obj


def render_previews(objects, materials, out_dir, samples):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.seed = 0
    scene.cycles.use_denoising = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.resolution_percentage = 100
    scene.world.color = (0.35,0.6,0.8)
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.get("Background").inputs["Color"].default_value = (0.38,0.66,0.88,1)
    scene.world.node_tree.nodes.get("Background").inputs["Strength"].default_value = 0.7
    scene.view_settings.view_transform = "AgX"
    grass = material("PreviewGrass",(0.17,0.29,0.075))
    bpy.ops.mesh.primitive_plane_add(size=60,location=(0,0,-0.015))
    ground = bpy.context.object
    ground.data.materials.append(grass)
    light = bpy.data.lights.new("PreviewSun","SUN")
    light.energy, light.angle = 2.4,0.18
    sun = bpy.data.objects.new("PreviewSun",light)
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = native((3,-8,-5)).to_track_quat("-Z","Y").to_euler()
    camera = bpy.data.objects.new("PreviewCamera",bpy.data.cameras.new("PreviewCamera"))
    bpy.context.collection.objects.link(camera)
    camera.data.type = "ORTHO"
    scene.camera = camera

    def render(filename,position,target,scale,width=640,height=640):
        point_camera(camera,position,target,scale)
        scene.render.resolution_x,scene.render.resolution_y = width,height
        scene.render.filepath = str(out_dir/filename)
        bpy.ops.render.render(write_still=True)

    offsets = (-10,-6,0,4.4,7.0,10.7)
    labels = []
    for obj,x in zip(objects,offsets):
        y = 3.1 if obj.name == "StarterFlag" else 0
        obj.location = native((x,y,0))
        labels.append(text_object(obj.name,(x,0.08,1.9),0.26,materials[3]))
    m = Mesh()
    m.pipe((0,0,0),(0,2.9,0),0.24,"Dark",12)
    reference = m.finish("PreviewHumanScale",materials)
    reference.location = native((13.8,0,0))
    labels.append(text_object("2.9 units",(13.8,0.08,1.9),0.26,materials[3]))
    render("lineup.png",(20,14,50),(1.5,6.35,0),32,1280,640)
    reference.hide_render = True
    for obj in labels:
        obj.hide_render = True
    for obj in objects:
        obj.hide_render = True
        obj.location = (0,0,0)
    for obj in objects:
        obj.hide_render = False
        points = [game(v.co) for v in obj.data.vertices]
        low = [min(p[i] for p in points) for i in range(3)]
        high = [max(p[i] for p in points) for i in range(3)]
        center = [(a+b)/2 for a,b in zip(low,high)]
        scale = max(high[i]-low[i] for i in range(3))*1.28
        ground.scale = (scale/25,scale/25,1)
        is_flag = obj.name == "StarterFlag"
        if is_flag:
            ground.hide_render = True
        position = (center[0]+scale*0.7,center[1]+scale*0.40,center[2]+scale*2)
        is_starter = obj.name == "StarterStand"
        if is_starter:
            position = (center[0]+scale*1.8,center[1]+scale*0.75,center[2]+scale*1.6)
        render(obj.name+".png",position,center,scale)
        ground.hide_render = False
        obj.hide_render = True

    # This temporary chart is rendered and applied after exporting the texture-free GLB.
    ground.hide_render = True
    chart = []
    for y in range(4):
        for x in range(4):
            tilemat = material("PreviewTile",(0.86,0.64,0.14) if (x+y)%2 else (0.09,0.3,0.55))
            tile = Mesh()
            tile.box(((x+0.5)/4,(y+0.5)/4,-0.01),(0.25,0.25,0.01),"PaintWhite")
            obj = tile.finish("PreviewTile",materials)
            obj.data.materials[0] = tilemat
            chart.append(obj)
            chart.append(text_object(f"{x},{y}",((x+0.5)/4,(y+0.5)/4,0.01),0.065,materials[0]))
    chart.append(text_object("U >",(0.50,0.03,0.02),0.07,materials[3]))
    chart.append(text_object("V ^ TOP",(0.50,0.91,0.02),0.07,materials[3]))
    render("uv_checker_texture.png",(0.5,0.5,3),(0.5,0.5,0),1,512,512)
    for obj in chart:
        obj.hide_render = True
    image = bpy.data.images.load(str(out_dir/"uv_checker_texture.png"))
    for name in ("SignFace","FlagCloth"):
        mat = bpy.data.materials[name]
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        mat.node_tree.links.new(tex.outputs["Color"],mat.node_tree.nodes.get("Principled BSDF").inputs["Base Color"])
    ground.hide_render = False
    ground.scale = (1,1,1)
    pole,finish,_,_,flag_obj,_ = objects
    for obj,pos in ((pole,(-3.0,0,0)),(finish,(0,0,0)),(flag_obj,(2.3,3.9,0))):
        obj.location = native(pos)
        obj.hide_render = False
    back = bpy.data.objects.new("PreviewPoleBack",pole.data)
    bpy.context.collection.objects.link(back)
    back.location = native((-4.3,0,0))
    back.rotation_euler.z = math.pi
    for body,pos in (("BACK",(-4.3,4.0,0)),("FRONT",(-3,4,0)),("SHARED PANEL UV",(0,6.65,0)),("HOIST 0 > 1",(2.8,4.2,0))):
        text_object(body,pos,0.18,materials[3])
    render("uv_check.png",(-0.7,4.8,24),(-0.7,3.3,0),10,1280,960)


def main():
    start = time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,default=Path(__file__).resolve().parents[2]/"public/models/course-props.glb")
    parser.add_argument("--preview-dir",type=Path,default=PREVIEW_DIR)
    parser.add_argument("--samples",type=int,default=32)
    parser.add_argument("--skip-previews",action="store_true")
    has_separator = "--" in sys.argv
    args = parser.parse_args(sys.argv[sys.argv.index("--")+1:] if has_separator else [])
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.preview_dir.mkdir(parents=True,exist_ok=True)
    source_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    previous_stats_path = args.preview_dir/"stats.json"
    previous_stats = json.loads(previous_stats_path.read_text()) if previous_stats_path.exists() else {}
    previous_nodes = node_fingerprints(args.output) if args.output.exists() else {}
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    colors = ((0.86,0.89,0.86),(0.65,0.015,0.026),(0.36,0.42,0.45),(0.025,0.035,0.043),
              (0.07,0.23,0.29),(0.96,0.95,0.89),(0.72,0.018,0.035),(0.025,0.23,0.21),
              (0.018,0.021,0.023))
    materials = [material(name,color,0.45 if name == "SteelGrey" else 0) for name,color in zip(NAMES,colors)]
    objects = [build(materials) for build in (furlong,finish_post,patrol,starter,flag,camera_platform)]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=str(args.output),export_format="GLB",use_selection=True,
                              export_yup=True,export_animations=False,export_cameras=False,export_lights=False,
                              export_texcoords=True,export_normals=True,export_materials="EXPORT",export_extras=True,
                              export_draco_mesh_compression_enable=False)
    nodes = inspect(args.output)
    fingerprints = node_fingerprints(args.output)
    unchanged_nodes = [name for name in previous_nodes if name != "StarterStand"]
    for name in unchanged_nodes:
        assert previous_nodes[name] == fingerprints[name],f"Unrelated node changed: {name}"
    glb_hash = hashlib.sha256(args.output.read_bytes()).hexdigest()
    same_source = previous_stats.get("source_sha256") == source_hash
    if same_source:
        assert previous_stats["glb_sha256"] == glb_hash,"Repeated generation changed GLB bytes"
    stats = {"blender_version":bpy.app.version_string,"coordinate_system":"+X running, +Y up, +Z track/front",
             "nodes":nodes,"glb_bytes":args.output.stat().st_size,"glb_sha256":glb_hash,
             "source_sha256":source_hash,"repeat_generation_identical":same_source,
             "node_fingerprints":fingerprints,"unchanged_nodes_verified":unchanged_nodes,
             "glb_path":str(args.output.resolve()),"flag_attachment":FLAG_ATTACHMENT,
             "starter_trailer":{"tire_diameter":0.7,"wheel_count":4,"frame_center_y":0.5,
                                "platform_height":2.5,"coupling_center":[0,0.4,3.05],"jack_count":4},
             "preview_renderer":"Cycles CPU","preview_samples":args.samples,"previews_rendered":not args.skip_previews,
             "vertex_count_note":"Exported vertices, including material, normal and UV seam splits.",
             "uv_note":"TEXCOORD_0 validated from GLB binary. Artist V up is stored as 1-V by glTF. Pole back U is reversed in world X to read left-to-right from back. Flag is one two-sided surface (64 triangles).",
             "validation":{"six_identity_mesh_nodes":True,"nine_named_materials":True,"uv_binary_values":True,
                           "no_images_textures_animations_cameras_lights_compression":True,"within_all_budgets":True}}
    do_preview = not args.skip_previews
    if do_preview:
        render_previews(objects,materials,args.preview_dir,args.samples)
    stats["generation_seconds"] = round(time.perf_counter()-start,3)
    encoded = json.dumps(stats,ensure_ascii=False,indent=2)
    (args.preview_dir/"stats.json").write_text(encoded+"\n",encoding="utf-8")
    print(encoded,flush=True)


if __name__ == "__main__":
    main()
