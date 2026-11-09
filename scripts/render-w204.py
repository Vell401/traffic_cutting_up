"""Inspect decoded final delivery, not the source Blender scene."""
import bpy,pathlib,math
import numpy as np
np.bool=bool
from mathutils import Vector
W=pathlib.Path('/tmp/opencode/w204');ROOT=pathlib.Path(__file__).resolve().parents[1]
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(W/'inspection.glb'))
s=bpy.context.scene;s.render.engine='CYCLES';s.cycles.samples=12;s.render.resolution_x=1000;s.render.resolution_y=700;s.render.resolution_percentage=100;s.world.color=(.35,.35,.35)
for loc,power in [((3,-4,6),1400),((-4,-1,4),1700),((0,5,5),1800)]:
 light=bpy.data.lights.new('Studio','AREA');light.energy=power;light.size=5;o=bpy.data.objects.new('Studio',light);s.collection.objects.link(o);o.location=loc;o.rotation_euler=(Vector((0,0,.7))-o.location).to_track_quat('-Z','Y').to_euler()
cam=bpy.data.objects.new('InspectionCamera',bpy.data.cameras.new('InspectionCamera'));s.collection.objects.link(cam);s.camera=cam;cam.data.lens=48
for name,loc,target in [('front',(4, -6,3),(0,0,.7)),('rear',(-4,6,2.7),(0,0,.7)),('side',(-6,0,1.8),(0,0,.7)),('cockpit',(-.344,-.17,1.16),(-.344,-1.2,.95))]:
 cam.location=loc;cam.rotation_euler=(Vector(target)-cam.location).to_track_quat('-Z','Y').to_euler();cam.data.lens=24 if name=='cockpit' else 48;s.render.filepath=str(ROOT/('docs/w204-model-'+name+'.png'));bpy.ops.render.render(write_still=True)
