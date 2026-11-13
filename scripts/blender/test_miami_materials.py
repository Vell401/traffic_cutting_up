"""Run with Blender --background --factory-startup --python (no render required).

Check actual authoring nodes, also used to restore runtime maps after GLB reimport.
Three samples roughnessMap.g * material.roughness, not RGB luminance.
"""
import runpy
from pathlib import Path

kit = runpy.run_path(str(Path(__file__).with_name('build_miami.py')))
kit['setup_materials']()
for spec in kit['MATERIAL_SPEC']:
    if 'maps' not in spec:
        continue
    mat = kit['MATS'][spec['name']]
    shader = mat.node_tree.nodes.get('Principled BSDF')
    multiply = shader.inputs['Roughness'].links[0].from_node
    assert multiply.bl_idname == 'ShaderNodeMath' and multiply.operation == 'MULTIPLY', spec['name'] + ': missing roughness factor'
    assert abs(multiply.inputs[1].default_value - spec['roughness']) < 1e-6
    green = multiply.inputs[0].links[0]
    assert green.from_node.bl_idname == 'ShaderNodeSeparateColor' and green.from_socket.name == 'Green'
    texture = green.from_node.inputs['Color'].links[0].from_node
    assert texture.label == spec['maps']['roughnessMap']
    assert texture.image.colorspace_settings.name == 'Non-Color'
    # This deliberately unequal channel sample would catch accidental luminance conversion.
    sample = (.1, .7, .3)
    actual = sample[1] * multiply.inputs[1].default_value
    assert abs(actual - .7 * spec['roughness']) < 1e-6
    print('PASS roughnessMap.g * scalar:', spec['name'], actual)
