"""Expand SVG use elements for portable export through ImageMagick."""

from copy import deepcopy
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SVG = ROOT / "docs/map-layout.svg"
NS = "{http://www.w3.org/2000/svg}"

tree = ET.parse(SVG)
root = tree.getroot()
ids = {node.get("id"): node for node in root.iter() if node.get("id")}
for parent in root.iter():
    for index, node in enumerate(list(parent)):
        if node.tag != NS + "use":
            continue
        replacement = deepcopy(ids[node.attrib["href"][1:]])
        replacement.attrib.pop("id", None)
        replacement.attrib.update({key: value for key, value in node.attrib.items() if key != "href"})
        parent.remove(node)
        parent.insert(index, replacement)

# Persist expanded paths so the editable SVG and PNG have identical styling.
ET.register_namespace("", "http://www.w3.org/2000/svg")
tree.write(SVG, encoding="unicode")
subprocess.run(
    ["convert", "-background", "none", str(SVG), str(ROOT / "docs/map-layout.png")],
    check=True,
)
