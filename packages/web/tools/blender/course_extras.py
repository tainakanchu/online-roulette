# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Deterministic racecourse extras, using only Blender's bundled Python.

Build in game coordinates (+X forward, +Y up); native coordinates are (X,-Z,Y).
Export before adding any preview assets. All mesh node transforms are identity.
Livery U reads left-to-right from outside; positive-Z side therefore uses front U=1.
Blender artist V points up, while the exported glTF texture V points down.
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

import bpy
import bmesh
from mathutils import Vector

# プレビュー画像と統計の出力先。環境変数 BLENDER_PREVIEW_DIR で変えられる（既定は OS の一時フォルダー）
OUT = Path(os.environ.get("BLENDER_PREVIEW_DIR", Path(tempfile.gettempdir()) / "online-roulette-blender")) / "extras"
COLORS = dict(PaintWhite='e7ece8', PaintRed='c92835', PaintGreen='247454', PaintYellow='efac27', Glass='294f60', Tire='20252a', Dark='293138', SteelGrey='899ba1', Concrete='b2b4a8', Asphalt='303b40', Foliage='3c7035', Bamboo='94824b', Wood='84644c', Flower='ffffff', Soil='493a2b', Lamp='ff1724', Skin='d9a57a', Uniform='4488ad', Pants='26394c', Cap='ecbe42', FlagCloth='fffdf0', LiveryFrontU0='e7ece8', LiveryFrontU1='e7ece8')
BUDGETS = dict(GateTractor=4000, HarrowTractor=5000, WaterTruck=4000, Ambulance=4000, AmbulanceBeacon=200, HorseAmbulance=6000, StaffPerson=400, FlagPerson=500, FlagPersonCloth=100, SteepleHedge=2500, SteepleFence=3000, HedgeSegment=600, ShrubCluster=1500, FlowerBed=3000, TunnelEntrance=1500, PhotoFinishTower=2500)
ATTACHMENT = (0.15, 3.65, 0.70)
HITCH_POINT = (-2.98, 0.70, 0.0)
BEACON_ATTACHMENT = (1.5, 3.26, 0.0)
LIVERIES = ('LiveryFrontU0', 'LiveryFrontU1')
MATS = {}


def native(p):
    return Vector((p[0], -p[2], p[1]))


def game(p):
    return (p[0], p[2], -p[1])


def linear(v):
    is_dark = v <= 0.04045
    if is_dark:
        return v / 12.92
    return ((v + 0.055) / 1.055) ** 2.4


def material(name, color):
    rgb = tuple(linear(int(color[i:i+2], 16)/255) for i in (0,2,4))
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb,1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*rgb,1)
    bsdf.inputs['Roughness'].default_value = 0.65
    mat.use_backface_culling = name != 'FlagCloth'
    is_metal = name == 'SteelGrey'
    if is_metal:
        bsdf.inputs['Metallic'].default_value = 0.65
    is_glass = name == 'Glass'
    if is_glass:
        bsdf.inputs['Roughness'].default_value = 0.16
        bsdf.inputs['Metallic'].default_value = 0.3
    is_lamp = name == 'Lamp'
    if is_lamp:
        bsdf.inputs['Emission Color'].default_value = (*rgb,1)
        bsdf.inputs['Emission Strength'].default_value = 2.5
    is_flower = name == 'Flower'
    if is_flower:
        color_node = mat.node_tree.nodes.new('ShaderNodeVertexColor')
        color_node.layer_name = 'Color'
        mat.node_tree.links.new(color_node.outputs['Color'],bsdf.inputs['Base Color'])
    return mat


class Mesh:
    def __init__(self):
        self.v, self.f, self.mat, self.uv, self.color, self.smooth = [], [], [], [], [], []

    def add(self, vertices, faces, mat, uv=None, color=(1,1,1,1), smooth=False):
        off = len(self.v)
        self.v.extend(tuple(p) for p in vertices)
        for face in faces:
            self.f.append(tuple(off+i for i in face))
            self.mat.append(mat)
            self.uv.append([uv(vertices[i]) for i in face] if uv else None)
            self.color.append(color)
            self.smooth.append(smooth)

    def box(self, c, s, mat, bevel=0):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        for v in bm.verts:
            v.co = Vector(tuple(v.co[i]*s[i] for i in range(3)))
        has_bevel = bevel > 0
        if has_bevel:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1, affect='EDGES')
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        self.add([v.co+Vector(c) for v in bm.verts], [[v.index for v in f.verts] for f in bm.faces], mat)
        bm.free()

    def pipe(self, a, b, r, mat, sides=8, r2=None):
        a,b = Vector(a),Vector(b)
        axis = (b-a).normalized()
        ref = Vector((0,1,0))
        is_vertical = abs(axis.dot(ref)) > 0.95
        if is_vertical:
            ref = Vector((1,0,0))
        u = axis.cross(ref).normalized()
        v = axis.cross(u)
        vertices = [p+radius*(u*math.cos(i*math.tau/sides)+v*math.sin(i*math.tau/sides)) for p,radius in ((a,r),(b,r if r2 is None else r2)) for i in range(sides)]
        faces = [(i,(i+1)%sides,(i+1)%sides+sides,i+sides) for i in range(sides)]
        faces += [tuple(reversed(range(sides))),tuple(range(sides,2*sides))]
        self.add(vertices, faces, mat)

    def ico(self, c, s, mat, subdivisions=2, color=(1,1,1,1), smooth=False, distortion=0):
        bm = bmesh.new()
        bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=1)
        bm.verts.ensure_lookup_table()
        bm.verts.index_update()
        vertices = []
        for v in bm.verts:
            x,y,z = v.co
            wave = math.sin(2.7*x+0.6)*math.cos(2.1*z-0.4)+0.45*math.sin(3.2*y+1.1*z)
            radial = 1+distortion*wave/1.45
            vertices.append(tuple(c[i]+v.co[i]*s[i]*radial for i in range(3)))
        has_distortion = distortion > 0
        if has_distortion:
            bottom = min(p[1] for p in vertices)
            vertices = [(x,y-bottom,z) for x,y,z in vertices]
        self.add(vertices, [[v.index for v in f.verts] for f in bm.faces], mat,color=color,smooth=smooth)
        bm.free()

    def extrude(self, outline, width, mat, livery=False, uv_bounds=None):
        n = len(outline)
        vertices = [(x,y,z) for z in (-width/2,width/2) for x,y in outline]
        self.add(vertices,[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)],mat)
        x0,x1 = min(p[0] for p in outline),max(p[0] for p in outline)
        y0,y1 = min(p[1] for p in outline),max(p[1] for p in outline)
        has_shared_bounds = uv_bounds is not None
        if has_shared_bounds:
            x0,x1,y0,y1 = uv_bounds
        for side,face in ((-1,tuple(reversed(range(n)))),(1,tuple(range(n,2*n)))):
            uv = (lambda p,side=side: ((p[0]-x0)/(x1-x0) if side == 1 else (x1-p[0])/(x1-x0),(p[1]-y0)/(y1-y0))) if livery else None
            side_mat = 'LiveryFrontU1' if side == 1 else 'LiveryFrontU0'
            self.add(vertices,[face],side_mat if livery else mat,uv=uv)

    def finish(self, name):
        data = bpy.data.meshes.new(name)
        data.from_pydata([native(p) for p in self.v],[],self.f)
        names = list(dict.fromkeys(self.mat))
        for mat in names:
            data.materials.append(MATS[mat])
        has_uv = any(u is not None for u in self.uv)
        uv = data.uv_layers.new(name='UVMap') if has_uv else None
        has_color = 'Flower' in names
        colors = data.color_attributes.new(name='Color',type='FLOAT_COLOR',domain='CORNER') if has_color else None
        for poly,mat,face_uv,color,smooth in zip(data.polygons,self.mat,self.uv,self.color,self.smooth):
            poly.material_index = names.index(mat)
            poly.use_smooth = smooth
            for j,loop in enumerate(poly.loop_indices):
                if has_uv:
                    uv.data[loop].uv = face_uv[j] if face_uv else (0,0)
                if has_color:
                    colors.data[loop].color = color
        data.update()
        obj = bpy.data.objects.new(name,data)
        bpy.context.collection.objects.link(obj)
        return obj


def wheel(m,x,y,z,r,width=0.4,tractor=False):
    profile = [(-width/2,0.58*r),(-width/2,0.87*r),(-width*0.32,r),(width*0.32,r),(width/2,0.87*r),(width/2,0.58*r)]
    n = 16
    vertices = [(x+rr*math.cos(i*math.tau/n),y+rr*math.sin(i*math.tau/n),z+dz) for dz,rr in profile for i in range(n)]
    faces = [(j*n+i,j*n+(i+1)%n,((j+1)%len(profile))*n+(i+1)%n,((j+1)%len(profile))*n+i) for j in range(len(profile)) for i in range(n)]
    m.add(vertices,faces,'Tire')
    m.pipe((x,y,z-width*0.52),(x,y,z+width*0.52),r*0.56,'PaintYellow' if tractor else 'SteelGrey',12)
    m.pipe((x,y,z-width*0.55),(x,y,z+width*0.55),r*0.21,'Dark',8)
    if tractor:
        for i in range(16):
            angle = i*math.tau/16
            a = (x+r*1.005*math.cos(angle),y+r*1.005*math.sin(angle),z-width*0.3)
            b = (x+r*1.005*math.cos(angle+0.13),y+r*1.005*math.sin(angle+0.13),z+width*0.3)
            m.pipe(a,b,0.043,'Tire',4)


def tractor_mesh():
    m = Mesh()
    m.box((0,0.88,0),(4.2,0.38,1.2),'Dark',0.1)
    m.box((0.9,1.66,0),(2.3,1.2,1.33),'PaintYellow',0.14)
    m.box((2.09,1.55,0),(0.03,0.7,1.03),'Dark')
    for z in (-0.45,0.45):
        m.box((2.13,1.96,z),(0.04,0.22,0.25),'PaintWhite',0.03)
    for z in (-1,1):
        wheel(m,-1.35,1.029,z,0.98,0.60,True)
        wheel(m,1.45,0.689,z*0.89,0.64,0.38,True)
        m.box((-1.15,2.02,z),(1.7,0.14,0.72),'PaintYellow',0.045)
        m.box((-0.2,0.64,z*0.82),(0.64,0.12,0.42),'SteelGrey')
        m.pipe((-1.6,1.62,z*0.65),(-1.6,3.45,z*0.65),0.06,'Dark')
    m.box((-0.96,3.52,0),(2.2,0.18,1.96),'PaintYellow',0.07)
    m.box((-1.02,1.57,0),(0.73,0.2,0.77),'Tire',0.06)
    m.box((-1.37,1.89,0),(0.16,0.68,0.76),'Tire',0.055)
    m.pipe((-0.23,1.34,0),(-0.51,2.08,0),0.05,'Dark')
    m.pipe((-0.53,2.1,-0.26),(-0.53,2.1,0.26),0.045,'Dark')
    m.pipe((0.5,1.9,-0.63),(0.5,3.03,-0.63),0.075,'Dark')
    m.box((2.27,0.91,0),(0.42,0.24,1.75),'SteelGrey')
    m.box((-2.53,0.60,0),(1.16,0.16,0.34),'SteelGrey',0.025)
    for z in (-0.38,0.38):
        m.pipe((-1.98,0.9,z),(-2.67,0.64,0),0.055,'SteelGrey',6)
    m.pipe((-2.98,0.5,0),(-2.98,0.84,0),0.075,'Dark',10)
    m.pipe((-2.98,0.85,-0.14),(-2.98,0.85,0.14),0.04,'SteelGrey',6)
    return m


def tractor():
    obj = tractor_mesh().finish('GateTractor')
    obj['hitch_point'] = list(HITCH_POINT)
    return obj


def harrow_tractor():
    m = tractor_mesh()
    m.v = [(x+2,y,z) for x,y,z in m.v]
    m.mat = ['PaintGreen' if name == 'PaintYellow' else name for name in m.mat]
    for z in (-2.85,2.85):
        m.pipe((-0.98,0.70,0),(-2.20,0.64,z),0.07,'SteelGrey',6)
        m.box((-3.22,0.60,z),(2.25,0.14,0.15),'SteelGrey')
    for x in (-2.18,-3.23,-4.28):
        m.box((x,0.56,0),(0.17,0.19,6.6),'SteelGrey')
        for i in range(23):
            z = -3.13+i*6.26/22
            m.pipe((x,0.55,z),(x-0.11,0.20,z),0.027,'Dark',4)
            m.pipe((x-0.11,0.20,z),(x-0.25,0.029,z),0.027,'Dark',4)
    m.box((-4.50,0.13,0),(0.11,0.13,6.55),'SteelGrey')
    m.pipe((-3.70,0.63,-3.28),(-3.70,0.63,3.28),0.07,'SteelGrey',8)
    for z in (-3.1,3.1):
        m.pipe((-3.70,0.18,z-0.10),(-3.70,0.18,z+0.10),0.18,'Dark',10)
    return m.finish('HarrowTractor')


def water_truck():
    m = Mesh()
    m.box((0,0.87,0),(8.6,0.33,2.6),'Dark',0.08)
    m.extrude([(1.55,1.0),(4.32,1.0),(4.32,2.40),(3.98,3.78),(3.72,3.98),(1.55,3.98)],2.78,'PaintGreen')
    m.box((-1.15,1.17,0),(5.45,0.20,2.93),'SteelGrey',0.035)
    for side in (-1,1):
        for x in (-2.80,-1.25,3.17):
            wheel(m,x,0.74,side*1.37,0.74,0.38)
        m.add([(1.82,2.63,side*1.401),(4.18,2.63,side*1.401),(3.82,3.75,side*1.401),(1.82,3.75,side*1.401)],[(0,1,2,3) if side==1 else (3,2,1,0)],'Glass')
        m.box((2.06,2.39,side*1.43),(0.40,0.06,0.05),'Dark')
        m.pipe((3.98,2.89,side*1.39),(3.98,2.99,side*1.76),0.04,'SteelGrey',6)
        m.box((3.98,3.16,side*1.79),(0.20,0.57,0.13),'Dark',0.03)
        m.box((2.20,0.70,side*1.39),(0.73,0.13,0.42),'SteelGrey')
        m.box((4.35,1.55,side*0.95),(0.06,0.28,0.45),'PaintWhite')
        m.box((-4.20,1.18,side*1.10),(0.06,0.22,0.23),'Lamp')
    m.add([(4.32,2.54,-1.22),(4.32,2.54,1.22),(4.02,3.74,1.22),(4.02,3.74,-1.22)],[(3,2,1,0)],'Glass')
    m.box((4.43,1.05,0),(0.14,0.25,2.85),'SteelGrey',0.04)
    m.box((4.35,1.98,0),(0.05,0.55,1.43),'Dark')
    # Profile rings round the tank shoulders without a high-resolution modifier.
    n = 24
    profile = [(-3.65,1.10),(-3.43,1.30),(1.02,1.30),(1.25,1.10)]
    vertices = [(x,2.61+r*math.cos(i*math.tau/n),r*math.sin(i*math.tau/n)) for x,r in profile for i in range(n)]
    faces = [(j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i) for j in range(3) for i in range(n)]
    m.add(vertices,faces,'PaintWhite',smooth=True)
    m.add(vertices,[tuple(reversed(range(n))),tuple(range(3*n,4*n))],'PaintWhite')
    for x in (-2.77,0.38):
        band = [(xx,2.61+1.314*math.cos(i*math.tau/n),1.314*math.sin(i*math.tau/n)) for xx in (x-0.065,x+0.065) for i in range(n)]
        m.add(band,[(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)],'SteelGrey',smooth=True)
    m.pipe((-1.08,3.83,0),(-1.08,4.08,0),0.34,'SteelGrey',16)
    for z in (-0.26,0.26):
        m.pipe((-3.82,0.70,z),(-3.82,3.63,z),0.034,'SteelGrey',6)
    for i in range(10):
        m.pipe((-3.82,0.75+i*0.30,-0.26),(-3.82,0.75+i*0.30,0.26),0.027,'SteelGrey',6)
    m.box((-3.82,1.34,-0.85),(0.61,0.53,0.55),'Dark',0.04)
    m.pipe((-3.7,1.5,-0.82),(-4.33,1.5,-0.82),0.09,'SteelGrey',8)
    m.pipe((-4.33,1.5,-0.82),(-4.33,0.59,-0.82),0.09,'SteelGrey',8)
    m.pipe((-4.38,0.59,-1.76),(-4.38,0.59,1.76),0.085,'SteelGrey',12)
    for i in range(13):
        z = -1.65+i*3.30/12
        m.pipe((-4.38,0.59,z),(-4.49,0.42,z),0.04,'SteelGrey',6)
    return m.finish('WaterTruck')


def vehicles():
    m = Mesh()
    outline = [(-3.35,0.77),(3.18,0.77),(3.38,1.65),(2.8,2.93),(2.36,3.24),(-3.24,3.24)]
    m.extrude(outline,2.65,'PaintWhite',True)
    m.box((0,0.7,0),(6.6,0.25,2.42),'Dark',0.08)
    for z in (-1,1):
        for x in (-2.08,2.12):
            wheel(m,x,0.65,z*1.30,0.65,0.33)
        m.box((-1.45,2.65,z*1.338),(2.5,0.63,0.025),'Glass',0.07)
        m.add([(1.13,2.12,z*1.345),(2.97,2.12,z*1.345),(2.53,2.97,z*1.345),(1.13,2.97,z*1.345)],[(0,1,2,3) if z==1 else (3,2,1,0)],'Glass')
        m.box((0.98,2.48,z*1.37),(0.06,1.35,0.02),'SteelGrey')
        m.box((1.42,1.96,z*1.375),(0.37,0.055,0.06),'Dark',0.015)
        m.pipe((2.73,2.03,z*1.31),(2.73,2.08,z*1.61),0.04,'Dark')
        m.box((2.70,2.2,z*1.64),(0.23,0.36,0.12),'Dark',0.03)
    m.add([(3.28,1.91,-1.16),(3.28,1.91,1.16),(2.83,2.92,1.16),(2.83,2.92,-1.16)],[(3,2,1,0)],'Glass')
    for z in (-0.9,0.9):
        m.box((3.35,1.29,z),(0.06,0.23,0.47),'PaintWhite',0.025)
        m.box((-3.36,1.65,z),(0.05,0.57,0.18),'Lamp')
    m.box((3.44,0.94,0),(0.12,0.19,2.55),'PaintWhite',0.035)
    m.box((-3.45,0.91,0),(0.10,0.18,2.55),'PaintWhite')
    m.box((3.4,1.46,0),(0.08,0.31,1.12),'Dark')
    m.box((-3.36,2.57,0),(0.03,0.76,2.06),'Glass',0.04)
    m.box((-3.39,2.10,0),(0.04,1.96,0.035),'SteelGrey')
    ambulance = m.finish('Ambulance')
    ambulance['beacon_attachment'] = list(BEACON_ATTACHMENT)
    b = Mesh()
    b.box((1.5,3.32,0),(0.46,0.12,2.15),'Dark',0.03)
    for z in (-0.73,0.73):
        b.box((1.5,3.49,z),(0.43,0.26,0.65),'Lamp',0.07)
    b.v = [tuple(p[i]-BEACON_ATTACHMENT[i] for i in range(3)) for p in b.v]
    beacon = b.finish('AmbulanceBeacon')
    beacon['mounting'] = 'Place local base origin at Ambulance.beacon_attachment.'
    m = Mesh()
    m.box((0,0.85,0),(10.3,0.4,2.6),'Dark',0.06)
    m.extrude([(-5.35,1.15),(2.25,1.15),(2.25,5.32),(2.07,5.5),(-5.17,5.5),(-5.35,5.32)],3.1,'PaintWhite',True)
    m.extrude([(2.35,0.96),(5.27,0.96),(5.35,2.48),(4.96,3.95),(4.68,4.18),(2.35,4.18)],2.9,'PaintWhite')
    for side in (-1,1):
        z = side*1.568
        for x in (-4.26,-2.66,-1.06,0.54):
            m.box((x,4.39,z),(1.18,0.44,0.045),'SteelGrey',0.04)
            m.box((x,4.39,z+side*0.029),(1.05,0.32,0.018),'Glass')
            for dx in (-0.28,0,0.28):
                m.box((x+dx,4.39,z+side*0.045),(0.028,0.33,0.028),'SteelGrey')
        m.add([(2.59,2.75,side*1.46),(5.12,2.75,side*1.46),(4.82,3.88,side*1.46),(2.59,3.88,side*1.46)],[(0,1,2,3) if side==1 else (3,2,1,0)],'Glass')
        m.box((3.78,1.94,side*1.464),(2.78,0.66,0.025),'PaintGreen')
        m.box((2.74,2.49,side*1.49),(0.4,0.06,0.06),'Dark')
        for x in (-3.48,-1.70,3.88):
            wheel(m,x,0.81,side*1.49,0.81,0.43)
        m.pipe((4.91,2.93,side*1.42),(4.93,3.07,side*1.89),0.055,'SteelGrey')
        m.box((4.9,3.23,side*1.92),(0.28,0.68,0.15),'Dark',0.045)
        m.box((2.95,0.66,side*1.43),(0.76,0.15,0.5),'SteelGrey')
    m.add([(5.34,2.62,-1.28),(5.34,2.62,1.28),(5.02,3.85,1.28),(5.02,3.85,-1.28)],[(3,2,1,0)],'Glass')
    m.box((5.44,1.12,0),(0.12,0.29,2.95),'SteelGrey',0.03)
    m.box((5.35,1.85,0),(0.08,0.61,1.5),'Dark')
    for z in (-1.02,1.02):
        m.box((5.37,1.55,z),(0.08,0.29,0.45),'PaintWhite')
    m.box((-5.39,2.8,0),(0.07,3.25,2.8),'PaintGreen',0.025)
    for z in (-1.39,1.39):
        m.box((-5.46,2.81,z),(0.06,3.38,0.07),'SteelGrey')
        m.box((-5.47,1.14,z),(0.04,0.39,0.16),'Lamp')
    for y in (1.38,1.85,2.32,2.79,3.26,3.73,4.2):
        m.box((-5.45,y,0),(0.05,0.055,2.72),'SteelGrey')
    return [ambulance,beacon,m.finish('HorseAmbulance')]


def person(flag=False):
    m = Mesh()
    for z in (-0.18,0.18):
        m.box((0.085,0.095,z),(0.46,0.19,0.27),'Dark')
        m.pipe((0,0.2,z),(0,1.14,z),0.125,'Pants',6,r2=0.155)
    m.box((0,1.18,0),(0.39,0.28,0.56),'Pants')
    m.pipe((0,1.27,0),(0,1.99,0),0.33,'Uniform',6,r2=0.37)
    m.pipe((0,1.98,0),(0,2.12,0),0.12,'Skin',6)
    m.ico((0,2.27,0),(0.225,0.28,0.225),'Skin',1)
    m.pipe((0,2.46,0),(0,2.6,0),0.24,'Cap',8)
    m.box((0.18,2.49,0),(0.38,0.045,0.4),'Cap')
    m.box((0.305,1.64,0),(0.02,0.58,0.036),'PaintWhite')
    for side in (-1,1):
        raised = flag and side == 1
        a = (0,1.92,side*0.31)
        b = (0.08,2.0,0.59) if raised else (0,1.51,side*0.43)
        c = (0.15,2.44,0.70) if raised else (0.07,1.15,side*0.45)
        m.pipe(a,b,0.13,'Uniform',6,r2=0.11)
        m.pipe(b,c,0.10,'Uniform',6,r2=0.075)
        m.ico(c,(0.1,0.13,0.1),'Skin',1)
    if flag:
        m.pipe((0.15,1.96,0.70),ATTACHMENT,0.023,'Wood',6)
    obj = m.finish('FlagPerson' if flag else 'StaffPerson')
    if flag:
        obj['cloth_attachment'] = list(ATTACHMENT)
    return obj


def flag_cloth():
    m = Mesh()
    v = [(x*0.9/8,-y*0.6/4,0) for y in range(5) for x in range(9)]
    f = [(y*9+x,y*9+x+9,y*9+x+10,y*9+x+1) for y in range(4) for x in range(8)]
    m.add(v,f,'FlagCloth')
    obj = m.finish('FlagPersonCloth')
    obj['grid'] = [8,4]
    obj['attachment_node'] = 'FlagPerson'
    return obj


def rail(m,x,width=6):
    for z in (-width/2+0.16,width/2-0.16):
        m.box((x,0.25,z),(0.18,0.5,0.18),'PaintWhite')
    m.box((x,0.4,0),(0.16,0.18,width),'PaintWhite',0.025)


def hedge_mesh(m,length=6,height=1.6,depth=1.2,along_x=True):
    # Identical end rings allow exact end-to-end tiling without a bevel gap.
    profile = [(-depth/2,0.0),(depth/2,0.0),(depth/2,height-0.23),(depth*0.40,height-0.05),(depth*0.22,height),(-depth*0.22,height),(-depth*0.40,height-0.05),(-depth/2,height-0.23)]
    rings = 21
    vertices = []
    for i in range(rings):
        along = -length/2+length*i/(rings-1)
        edge_distance = length/2-abs(along)
        envelope = max(0,min(1,(edge_distance-0.3)/0.6)) if along_x else 1
        for z,y in profile:
            upper = max(0,(y/height-0.45)/0.55)
            wave = 0.065*math.sin(2.3*along+2.1*z)+0.025*math.cos(4.4*along-1.4*z)
            jitter = envelope*upper*wave
            lateral = envelope*upper*0.055*math.sin(2.7*along+3.1*z)
            vertices.append((along,y+jitter,z+lateral) if along_x else (z+lateral,y+jitter,along))
    n = len(profile)
    faces = [(j*n+i,j*n+(i+1)%n,(j+1)*n+(i+1)%n,(j+1)*n+i) for j in range(rings-1) for i in range(n)]
    faces += [tuple(reversed(range(n))),tuple((rings-1)*n+i for i in range(n))]
    # The X extrusion profile has opposite handedness to the Z extrusion.
    if along_x:
        faces = [tuple(reversed(f)) for f in faces]
    m.add(vertices,faces,'Foliage')


def planting():
    m = Mesh()
    hedge_mesh(m,height=1.9,depth=1.45,along_x=False)
    for x in (-0.96,0.96):
        rail(m,x)
    hedge = m.finish('SteepleHedge')
    m = Mesh()
    rng = random.Random(731)
    for row in range(4):
        for i in range(44):
            x,z = -0.30+row*0.20,-2.94+i*5.86/43+(row%2)*0.025
            height = rng.uniform(1.7,1.95)
            m.pipe((x,0.05,z),(x+0.018,height,z),0.075,'Bamboo',4)
    for x in (-0.44,0.46):
        for y in (0.49,1.24):
            m.box((x,y,0),(0.12,0.14,6),'Wood')
    for x in (-0.64,0.64):
        rail(m,x)
    fence = m.finish('SteepleFence')
    m = Mesh()
    hedge_mesh(m)
    segment = m.finish('HedgeSegment')
    m = Mesh()
    for c,s in (((-0.95,0.78,-0.5),(1.05,0.78,0.87)),((0.88,0.85,-0.40),(1.0,0.85,0.91)),((0,0.91,0.53),(1.2,0.91,1.02)),((-1.18,0.55,0.65),(0.72,0.55,0.62))):
        m.ico(c,s,'Foliage',3,smooth=True,distortion=0.08)
    shrub = m.finish('ShrubCluster')
    m = Mesh()
    m.box((0,0.1,0),(8,0.2,3),'Concrete',0.055)
    m.box((0,0.22,0),(7.70,0.22,2.70),'Soil')
    for z in (-1.42,1.42):
        m.box((0,0.27,z),(8,0.24,0.16),'Concrete',0.04)
    for x in (-3.92,3.92):
        m.box((x,0.27,0),(0.16,0.24,2.84),'Concrete',0.04)
    palette = [(0.95,0.055,0.13,1),(1,0.61,0.025,1),(0.54,0.17,0.8,1),(0.97,0.90,0.72,1)]
    rng = random.Random(104)
    for row in range(4):
        for i in range(17):
            x,z = -3.52+i*0.44,-0.98+row*0.65
            dx,dy,dz = [rng.uniform(-0.05,0.05) for _ in range(3)]
            size = rng.uniform(0.8,1.2)
            m.ico((x+dx,0.40,z+dz),(0.24*size,0.18*size,0.26*size),'Foliage',1)
            m.ico((x+dx,0.58+dy,z+dz),(0.20*size,0.18*size,0.23*size),'Flower',1,color=palette[row])
    return [hedge,fence,segment,shrub,m.finish('FlowerBed')]


def tunnel():
    m = Mesh()
    # Below-ground geometry remains useful if the host later cuts the terrain.
    v = [(-7,-3,-2.65),(7,0,-2.65),(7,0,2.65),(-7,-3,2.65)]
    m.add(v,[(3,2,1,0)],'Asphalt')
    for side in (-1,1):
        z = side*2.83
        m.extrude([(-7,-3.12),(7,-0.12),(7,0.5),(-7,0.9)],0.36,'Concrete')
        # Move just this new wall, preserving the shared origin of the asset.
        for i in range(len(m.v)-24,len(m.v)):
            p = m.v[i]
            m.v[i] = (p[0],p[1],p[2]+z)
        m.pipe((-6.8,1.34,z),(6.6,0.97,z),0.045,'SteelGrey')
        for x in (-6.8,-3.5,0,3.5,6.6):
            y = 0.9-(x+7)*0.4/14
            m.pipe((x,y,z),(x,y+0.48,z),0.038,'SteelGrey')
    m.box((-5.43,0.93,0),(3.15,0.30,6.05),'Concrete',0.06)
    m.box((-3.89,0.75,0),(0.1,0.22,5.34),'PaintGreen')
    m.box((-6.90,-1.4,0),(0.15,3.0,5.3),'Dark')
    # A flat terrain would occlude a literal excavation: this dark lip masks it.
    m.box((0,0.018,0),(13.95,0.016,5.28),'Asphalt')
    m.box((-4.72,0.032,0),(4.44,0.01,5.28),'Dark')
    for side in (-1,1):
        m.add([(-6.9,0.045,side*2.61),(6.9,0.045,side*2.61),(5.4,0.046,side*2.15),(-6.9,0.046,side*1.66)],[(0,1,2,3) if side==1 else (3,2,1,0)],'Dark')
    obj = m.finish('TunnelEntrance')
    obj['terrain_overlay_y'] = 0.026
    obj['slope_depth'] = 3.0
    return obj


def tower():
    m = Mesh()
    for x in (-0.73,0.73):
        for z in (-0.73,0.73):
            m.box((x,0.12,z),(0.48,0.24,0.48),'Concrete',0.035)
            m.pipe((x,0.24,z),(x*0.68,6.15,z*0.68),0.07,'SteelGrey')
    for h in (0.6,2.25,3.9,5.55):
        width = 0.73*(1-0.32*h/6.15)
        for side in (-1,1):
            for swap in (False,True):
                a,b = (-width,h,side*width),(width,h+1.5,side*width*0.90)
                c,d = (width,h,side*width),(-width,h+1.5,side*width*0.90)
                if swap:
                    a,b,c,d = [(p[2],p[1],p[0]) for p in (a,b,c,d)]
                m.pipe(a,b,0.025,'SteelGrey',6)
                m.pipe(c,d,0.025,'SteelGrey',6)
    m.box((0,6.23,0),(2.55,0.18,2.4),'SteelGrey')
    m.box((0,6.71,0),(2.12,0.82,1.98),'PaintWhite',0.035)
    m.box((0,7.36,0),(2.06,0.68,1.93),'Glass')
    for x in (-1.055,1.055):
        for z in (-0.985,0.985):
            m.box((x,7.35,z),(0.075,0.76,0.075),'PaintWhite')
    m.box((0,7.9,0),(2.54,0.20,2.35),'PaintGreen',0.035)
    m.box((1.17,7.18,0),(0.36,0.26,0.36),'Dark')
    m.pipe((1.3,7.18,0),(1.57,7.18,0),0.105,'Dark',10)
    for z in (-0.25,0.25):
        m.pipe((-0.91,0.3,z),(-0.91,6.5,z),0.035,'SteelGrey')
    for i in range(21):
        m.pipe((-0.91,0.35+i*0.29,-0.25),(-0.91,0.35+i*0.29,0.25),0.023,'SteelGrey',6)
    return m.finish('PhotoFinishTower')



def strip_unused_uvs(path):
    # Blender stores UV layers per mesh; remove dummy attributes from other materials.
    raw = path.read_bytes()
    size = struct.unpack_from('<I', raw, 12)[0]
    doc = json.loads(raw[20:20+size])
    for mesh in doc['meshes']:
        for primitive in mesh['primitives']:
            material_name = doc['materials'][primitive['material']]['name']
            is_untextured = material_name not in LIVERIES
            if is_untextured:
                primitive['attributes'].pop('TEXCOORD_0', None)
    encoded = json.dumps(doc, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    encoded += b' ' * (-len(encoded) % 4)
    binary_chunk = raw[20+size:]
    total = 20+len(encoded)+len(binary_chunk)
    path.write_bytes(struct.pack('<4sII', b'glTF', 2, total)
                     + struct.pack('<I4s', len(encoded), b'JSON') + encoded + binary_chunk)


def inspect_glb(path):
    raw = path.read_bytes()
    size = struct.unpack_from('<I',raw,12)[0]
    doc = json.loads(raw[20:20+size])
    binary = raw[28+size:]
    def accessor(index):
        acc = doc['accessors'][index]
        view = doc['bufferViews'][acc['bufferView']]
        components = dict(SCALAR=1,VEC2=2,VEC3=3,VEC4=4)[acc['type']]
        kind = {5126:'f',5125:'I',5123:'H',5121:'B'}[acc['componentType']]
        fmt = '<'+kind*components
        stride = view.get('byteStride',struct.calcsize(fmt))
        start = view.get('byteOffset',0)+acc.get('byteOffset',0)
        return [struct.unpack_from(fmt,binary,start+i*stride) for i in range(acc['count'])]
    assert not any(doc.get(key) for key in ('images','textures','animations','cameras','skins'))
    assert not any('compression' in x.lower() or 'lights' in x.lower() for x in doc.get('extensionsUsed',[]))
    assert {n['name'] for n in doc['nodes']} == set(BUDGETS)
    assert 'Livery' not in {m['name'] for m in doc['materials']}
    stats = {}
    uv_checks = []
    for node in doc['nodes']:
        name = node['name']
        assert not any(key in node for key in ('translation','rotation','scale','matrix','children'))
        positions,materials,triangles,verts = [],set(),0,0
        for primitive in doc['meshes'][node['mesh']]['primitives']:
            attrs = primitive['attributes']
            points = accessor(attrs['POSITION'])
            positions.extend(points)
            verts += len(points)
            triangles += doc['accessors'][primitive['indices']]['count']//3
            mat = doc['materials'][primitive['material']]['name']
            materials.add(mat)
            is_livery = mat in LIVERIES
            if is_livery:
                uv = accessor(attrs['TEXCOORD_0'])
                assert all(-0.00001<=a<=1.00001 for pair in uv for a in pair)
                by_side = {}
                for p,t in zip(points,uv):
                    by_side.setdefault(1 if p[2]>0 else -1,[]).append((p,t))
                for side,pairs in by_side.items():
                    assert mat == ('LiveryFrontU1' if side==1 else 'LiveryFrontU0')
                    for i,(p,t) in enumerate(pairs):
                        for q,u in pairs[i+1:]:
                            comparable = abs(p[2]-q[2])<0.001 and abs(p[0]-q[0])>0.01
                            if comparable:
                                assert (t[0]-u[0])*(p[0]-q[0])*side > -0.00001
                    uv_checks.append(dict(node=name,material=mat,side=side,front_u=1 if side==1 else 0,outward_readable=True,u_min=min(t[0] for _,t in pairs),u_max=max(t[0] for _,t in pairs)))
                    assert abs(min(t[0] for _,t in pairs)) < 1e-5
                    assert abs(max(t[0] for _,t in pairs)-1) < 1e-5
                is_horse_body = name == 'HorseAmbulance'
                if is_horse_body:
                    assert all(-5.351 <= p[0] <= 2.251 for p in points)
            is_front_glass = mat == 'Glass' and name in ('Ambulance','HorseAmbulance')
            if is_front_glass:
                front_threshold = 3.2 if name == 'Ambulance' else 5.2
                normals = accessor(attrs['NORMAL'])
                for p,n in zip(points,normals):
                    is_front = p[0] > front_threshold
                    if is_front:
                        assert n[0] > 0
            is_flower = mat == 'Flower'
            if is_flower:
                assert 'COLOR_0' in attrs
                assert len(set(accessor(attrs['COLOR_0']))) == 4
            no_uv_asset = mat not in LIVERIES
            if no_uv_asset:
                assert 'TEXCOORD_0' not in attrs
        low = [min(p[i] for p in positions) for i in range(3)]
        high = [max(p[i] for p in positions) for i in range(3)]
        assert triangles <= BUDGETS[name], (name,triangles,BUDGETS[name])
        stats[name] = dict(triangles=triangles,vertices=verts,triangle_budget=BUDGETS[name],bounding_box=dict(min=[round(p,5) for p in low],max=[round(p,5) for p in high],size=[round(b-a,5) for a,b in zip(low,high)]),materials=sorted(materials))
        stats[name]['extras'] = node.get('extras',{})
        is_tractor = name == 'GateTractor'
        if is_tractor:
            assert node['extras']['hitch_point'] == list(HITCH_POINT)
        is_ambulance = name == 'Ambulance'
        if is_ambulance:
            assert node['extras']['beacon_attachment'] == list(BEACON_ATTACHMENT)
            assert 'PaintRed' not in materials
        is_beacon = name == 'AmbulanceBeacon'
        if is_beacon:
            assert abs(low[1]) < 1e-5 and abs(low[0]+high[0]) < 1e-5
        is_shrub = name == 'ShrubCluster'
        if is_shrub:
            assert verts < triangles
        is_hedge = name == 'HedgeSegment'
        if is_hedge:
            ends = [sorted(set((round(p[1],6),round(p[2],6)) for p in positions if abs(p[0]-x)<1e-5)) for x in (-3,3)]
            assert ends[0] == ends[1]
            guard_rings = [sorted(set((round(p[1],6),round(p[2],6)) for p in positions if abs(p[0]-x)<1e-5)) for x in (-2.7,2.7)]
            assert all(ring == ends[0] for ring in guard_rings)
            hedge = dict(matches=True,endpoint_x=[-3,3],cross_section_yz=ends[0],unperturbed_end_length=0.3,end_guard_rings_match=True)
        is_flag = name == 'FlagPerson'
        if is_flag:
            assert node['extras']['cloth_attachment'] == list(ATTACHMENT)
        is_cloth = name == 'FlagPersonCloth'
        if is_cloth:
            assert triangles == 64 and len(set(positions)) == 45
    assert len(raw) < 2_000_000
    return stats,hedge,uv_checks


def label(body,position,size,mat):
    data = bpy.data.curves.new('PreviewLabel','FONT')
    data.body,data.size,data.align_x = body,size,'CENTER'
    data.extrude = 0
    obj = bpy.data.objects.new('PreviewLabel',data)
    bpy.context.collection.objects.link(obj)
    obj.location = native(position)
    obj.rotation_euler = native((0,0,1)).to_track_quat('Z','Y').to_euler()
    data.materials.append(mat)
    return obj


def previews(objects,out,samples):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.seed = 0
    scene.cycles.use_denoising = True
    scene.render.image_settings.file_format = 'PNG'
    scene.render.resolution_percentage = 100
    scene.world.use_nodes = True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.38,0.66,0.88,1)
    scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.7
    scene.view_settings.view_transform = 'AgX'
    grass = material('PreviewGrass','729252')
    bpy.ops.mesh.primitive_plane_add(size=1000,location=(0,0,-0.016))
    ground = bpy.context.object
    ground.data.materials.append(grass)
    light = bpy.data.lights.new('PreviewSun','SUN')
    light.energy,light.angle = 2.3,0.18
    sun = bpy.data.objects.new('PreviewSun',light)
    bpy.context.collection.objects.link(sun)
    sun.rotation_euler = native((4,-8,-5)).to_track_quat('-Z','Y').to_euler()
    camera = bpy.data.objects.new('PreviewCamera',bpy.data.cameras.new('PreviewCamera'))
    bpy.context.collection.objects.link(camera)
    camera.data.type = 'ORTHO'
    scene.camera = camera
    def render(file,pos,target,scale,w=640,h=640):
        camera.location = native(target)+(native(pos)-native(target))*2
        camera.rotation_euler = (native(target)-camera.location).to_track_quat('-Z','Y').to_euler()
        camera.data.ortho_scale = scale
        horizontal = native((target[0]-pos[0],0,target[2]-pos[2])).normalized()
        ground.rotation_euler.z = math.atan2(horizontal.y,horizontal.x)-math.pi/2
        ground.location = native((target[0],-0.016,target[2]))+horizontal*(scale*0.75-500)
        scene.render.resolution_x,scene.render.resolution_y = w,h
        scene.render.filepath = str(out/file)
        bpy.ops.render.render(write_still=True)
    by_name = {o.name:o for o in objects}
    for obj in objects:
        obj.hide_render = True
    for obj in objects:
        obj.hide_render = False
        pts = [game(v.co) for v in obj.data.vertices]
        low = [min(p[i] for p in pts) for i in range(3)]
        high = [max(p[i] for p in pts) for i in range(3)]
        center = [(a+b)/2 for a,b in zip(low,high)]
        scale = max(b-a for a,b in zip(low,high))*1.40
        is_flag = obj.name == 'FlagPerson'
        if is_flag:
            cloth = by_name['FlagPersonCloth']
            cloth.location = native(ATTACHMENT)
            cloth.hide_render = False
        is_ambulance = obj.name == 'Ambulance'
        if is_ambulance:
            by_name['AmbulanceBeacon'].hide_render = False
            by_name['AmbulanceBeacon'].location = native(BEACON_ATTACHMENT)
        is_cloth = obj.name == 'FlagPersonCloth'
        ground.hide_render = is_cloth
        is_obstacle = obj.name in ('SteepleHedge','SteepleFence')
        elevation = 2.7 if is_obstacle else 0.53
        forward = 0.35 if is_obstacle else 0.76
        render(obj.name+'.png',(center[0]+scale*forward,center[1]+scale*elevation,center[2]+scale*1.4),center,scale)
        needs_rear_preview = obj.name in ('GateTractor','HarrowTractor','WaterTruck')
        if needs_rear_preview:
            render(obj.name+'_rear.png',(center[0]-scale*1.1,center[1]+scale*0.8,center[2]+scale*1.0),center,scale)
        ground.hide_render = False
        for other in objects:
            other.hide_render = True
            other.location = (0,0,0)
    # A single horizontal lineup retains every exported node, including loose parts.
    labels,refs = [],[]
    cursor = 0
    for i,obj in enumerate(objects):
        pts = [game(v.co) for v in obj.data.vertices]
        x0,x1 = min(p[0] for p in pts),max(p[0] for p in pts)
        width = max(x1-x0,1.6)
        x = cursor+width/2
        lift = 1.7 if obj.name == 'FlagPersonCloth' else 0
        obj.location = native((x-(x0+x1)/2,lift,0))
        obj.hide_render = False
        labels.append(label(obj.name,(x,0.03,3.7+(i%2)*0.7),0.32,MATS['Dark']))
        cursor += width+1.1
        needs_reference = i in (2,5,9,12)
        if needs_reference:
            ref = bpy.data.objects.new('PreviewScalePerson',by_name['StaffPerson'].data)
            bpy.context.collection.objects.link(ref)
            ref.location = native((cursor,0,0))
            refs.append(ref)
            labels.append(label('2.6',(cursor,0.03,3.5),0.30,MATS['Dark']))
            cursor += 1.8
    render('lineup.png',(cursor/2+4,20,55),(cursor/2,2,0),cursor+3,1600,800)
    for obj in [*objects,*labels,*refs]:
        obj.hide_render = True
        obj.location = (0,0,0)
    # Render the text chart with Blender itself; no image or third-party dependency.
    ground.hide_render = True
    for mat_name,palette in (('LiveryFrontU0',('397e67','e4cf7e')),('LiveryFrontU1',('7758aa','dd8791'))):
        chart = []
        for row in range(4):
            for col in range(4):
                mat = material('PreviewTile',palette[(row+col)%2])
                m = Mesh()
                m.box(((col+0.5)/4,(row+0.5)/4,-0.012),(0.25,0.25,0.01),'PaintWhite')
                tile = m.finish('PreviewTile')
                tile.data.materials[0] = mat
                chart.append(tile)
                chart.append(label(f'{col}:{row}',((col+0.5)/4,(row+0.45)/4,0),0.065,MATS['PaintWhite']))
        chart.append(label('TOP  ABC  123',(0.5,0.91,0.015),0.071,MATS['PaintWhite']))
        chart.append(label('U  >>>',(0.5,0.06,0.015),0.09,MATS['PaintWhite']))
        filename = mat_name+'_checker.png'
        render(filename,(0.5,0.5,3),(0.5,0.5,0),1,512,512)
        for obj in chart:
            obj.hide_render = True
        image = bpy.data.images.load(str(out/filename))
        mat = MATS[mat_name]
        tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
        tex.image = image
        mat.node_tree.links.new(tex.outputs['Color'],mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    for name,y in (('Ambulance',7),('HorseAmbulance',0)):
        for side,x in ((1,-7),(-1,7)):
            obj = bpy.data.objects.new('PreviewUV'+name,by_name[name].data)
            bpy.context.collection.objects.link(obj)
            obj.location = native((x,y,0))
            obj.rotation_euler.z = 0 if side==1 else math.pi
            label(name+('  +Z / FrontU1' if side==1 else '  -Z / FrontU0'),(x,y+5.9,0),0.35,MATS['PaintWhite'])
    render('uv_check.png',(0,7,50),(0,6.4,0),28,1600,900)


def main():
    start = time.perf_counter()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[2]/'public/models/course-extras.glb')
    parser.add_argument('--preview-dir',type=Path,default=OUT)
    parser.add_argument('--samples',type=int,default=32)
    parser.add_argument('--skip-previews',action='store_true')
    has_args = '--' in sys.argv
    args = parser.parse_args(sys.argv[sys.argv.index('--')+1:] if has_args else [])
    args.preview_dir.mkdir(parents=True,exist_ok=True)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)
    MATS.update({name:material(name,color) for name,color in COLORS.items()})
    objects = [tractor(),harrow_tractor(),water_truck(),*vehicles(),person(),person(True),flag_cloth(),*planting(),tunnel(),tower()]
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.select_set(True)
        obj['units'] = 'game world units; 1 metre approximately 1.5 units'
    bpy.ops.export_scene.gltf(filepath=str(args.output),export_format='GLB',use_selection=True,export_yup=True,export_animations=False,export_cameras=False,export_lights=False,export_texcoords=True,export_normals=True,export_materials='EXPORT',export_extras=True,export_draco_mesh_compression_enable=False)
    strip_unused_uvs(args.output)
    nodes,hedge,uv_checks = inspect_glb(args.output)
    stats = dict(revision=2,beacon_attachment=BEACON_ATTACHMENT,hitch_point=HITCH_POINT,blender_version=bpy.app.version_string,nodes=nodes,glb_bytes=args.output.stat().st_size,glb_sha256=hashlib.sha256(args.output.read_bytes()).hexdigest(),source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),hedge_segment_end_sections=hedge,cloth_attachment=ATTACHMENT,livery_uv_checks=uv_checks,uv_note='Outside-readable U: +Z front=1 rear=0, -Z front=0 rear=1. Artist V bottom=0 top=1; GLB V=1-artist V.',vertex_count_note='GLB vertices after normal, material, UV and color splits.',validation=dict(all_triangle_budgets=True,under_2mb=True,identity_nodes=True,no_textures_animations_cameras_lights_compression=True,flower_COLOR_0=True,cloth_grid_8_by_4=True),preview_renderer='Cycles CPU',preview_samples=args.samples)
    previous_path = args.preview_dir/'stats.json'
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    same_source = previous.get('source_sha256') == stats['source_sha256']
    stats['repeat_generation_identical'] = same_source and previous.get('glb_sha256') == stats['glb_sha256']
    if same_source:
        assert stats['repeat_generation_identical']
    stats['geometry_generation_seconds'] = round(time.perf_counter()-start,3)
    has_previews = not args.skip_previews
    if has_previews:
        previews(objects,args.preview_dir,args.samples)
    stats['previews_rendered'] = has_previews
    stats['generation_seconds'] = round(time.perf_counter()-start,3)
    encoded = json.dumps(stats,indent=2,ensure_ascii=False)
    previous_path.write_text(encoded+'\n')
    print(encoded,flush=True)


if __name__ == '__main__':
    main()
