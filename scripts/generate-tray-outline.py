#!/usr/bin/env python3
"""Derive the GNOME outline from the shared tray symbol."""

from pathlib import Path
import xml.etree.ElementTree as ET


source_dir = Path(__file__).resolve().parent.parent / "assets" / "source"
namespace = "http://www.w3.org/2000/svg"
ET.register_namespace("", namespace)
symbol = ET.parse(source_dir / "sidra-tray-symbol.svg").getroot()
outline = ET.Element(symbol.tag, symbol.attrib)
definitions = ET.SubElement(outline, f"{{{namespace}}}defs")
geometry = ET.SubElement(definitions, f"{{{namespace}}}g", id="tray-symbol")
geometry.extend(symbol)
ET.SubElement(outline, f"{{{namespace}}}use", {
    "href": "#tray-symbol",
    "fill": "#202124",
    "stroke": "#202124",
    "stroke-width": "32",
    "stroke-linejoin": "round",
})
ET.SubElement(outline, f"{{{namespace}}}use", {
    "href": "#tray-symbol",
    "fill": "#FFFFFF",
})
ET.indent(outline)
ET.ElementTree(outline).write(
    source_dir / "sidra-tray-outline.svg", encoding="UTF-8", xml_declaration=True,
)
