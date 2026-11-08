"""Bill of materials (FR-DAT-9): the parts of a project grouped, as CSV or XLSX.

Hierarchical blocks are expanded (a sheet placed twice counts twice; references get the block
path, ``X1/R2``); a library component is one part (its equivalent circuit is not a list of
parts). Ideal parts are listed as "to be chosen": they have a value but no real part yet.
Sources, probes, ground and power symbols and ideal controlled sources are not parts.
"""

import csv
import io
import re
import zipfile
from dataclasses import dataclass, field
from xml.sax.saxutils import escape

from bpt.document.model import Instance, Project, Sheet
from bpt.library.blocks import PREFIX, project_symbols
from bpt.library.symbols import Symbol

COLUMNS = ["Quantity", "References", "Value", "Part", "Manufacturer", "Part number", "Package",
           "Technology", "Status"]  # fmt: skip
_NOT_PARTS = {"V", "I", "E", "G", "F", "H", "B"}  # stimulus and ideal behaviour


@dataclass
class BomRow:
    value: str
    part: str
    manufacturer: str = ""
    part_number: str = ""
    package: str = ""
    technology: str = ""
    status: str = ""
    references: list[str] = field(default_factory=list)

    def cells(self) -> list[str | int]:
        refs = sorted(self.references, key=_natural)
        return [len(refs), ", ".join(refs), self.value, self.part, self.manufacturer,
                self.part_number, self.package, self.technology, self.status]  # fmt: skip


def _natural(ref: str) -> list[object]:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", ref)]


def _is_part(symbol: Symbol | None, inst: Instance) -> bool:
    if symbol is None or inst.ref.startswith("#") or symbol.power_net is not None:
        return False
    if symbol.id.startswith("bpt:probe"):
        return False
    return not (symbol.spice is not None and symbol.spice.element in _NOT_PARTS)


def _row(sheet_of: dict[str, Sheet], symbol: Symbol, inst: Instance) -> BomRow:
    params = {**symbol.default_params, **inst.model.params}
    block = sheet_of.get(inst.symbol[len(PREFIX) :]) if inst.symbol.startswith(PREFIX) else None
    info = block.component if block is not None else None
    if info is not None:
        main = symbol.value_param
        value = params.get(main, "") if main else ""
        meta = info.metadata
        return BomRow(
            value=value, part=info.name, manufacturer=meta.get("manufacturer", ""),
            part_number=meta.get("part_number", "") or info.name, package=meta.get("package", ""),
            technology=meta.get("technology", ""), status="library part",
        )  # fmt: skip
    model = inst.model.model or symbol.default_model
    value = params.get(symbol.value_param, "") if symbol.value_param else (model or "")
    parasitics = [p.label for p in symbol.parasitics if params.get(p.key, "").strip()]
    if symbol.id.startswith("bpt:") and not (model and symbol.default_model != model):
        status = "to be chosen (ideal)" if not parasitics else "to be chosen (quick model)"
    else:
        status = "model" if model else "library symbol"
    return BomRow(value=value, part=symbol.name, part_number=model or "", status=status)


def bom_rows(project: Project) -> list[BomRow]:
    symbols = project_symbols(project)
    sheet_of = {s.name: s for s in project.sheets}
    used = {i.symbol[len(PREFIX):] for s in project.sheets for i in s.instances
            if i.symbol.startswith(PREFIX)}  # fmt: skip
    rows: dict[tuple[str, ...], BomRow] = {}

    def walk(sheet: Sheet, path: str, depth: int) -> None:
        if depth > 32:  # a sheet inside itself: the netlist reports it
            return
        for inst in sheet.instances:
            symbol = symbols.get(inst.symbol)
            block = (
                sheet_of.get(inst.symbol[len(PREFIX) :]) if inst.symbol.startswith(PREFIX) else None
            )
            if block is not None and block.component is None:
                walk(block, f"{path}{inst.ref}/", depth + 1)  # a plain block: its parts count
                continue
            if symbol is None or not _is_part(symbol, inst):
                continue
            row = _row(sheet_of, symbol, inst)
            key = (row.part, row.value, row.manufacturer, row.part_number, row.package, row.status)
            rows.setdefault(key, row).references.append(f"{path}{inst.ref}")

    for sheet in project.sheets:
        if sheet.name not in used and sheet.owner is None:
            walk(sheet, "", 0)
    return sorted(rows.values(), key=lambda r: _natural(sorted(r.references, key=_natural)[0]))


_FORMULA = re.compile(r"[=@\t\r]|[+-](?![\d.])")  # what a spreadsheet would run as a formula
_XML_BAD = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")  # not allowed in XML at all


def csv_cell(value: str | int) -> str | int:
    """A cell a spreadsheet shows as text: ``=HYPERLINK(...)`` in a part name or manufacturer
    would run as a formula when the CSV is opened (values like ``-12V`` stay as they are)."""
    if isinstance(value, str) and _FORMULA.match(value):
        return "'" + value
    return value


def bom_csv(project: Project) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(COLUMNS)
    for row in bom_rows(project):
        writer.writerow([csv_cell(c) for c in row.cells()])
    return out.getvalue()


def _cell(ref: str, value: str | int, style: int = 0) -> str:
    s = f' s="{style}"' if style else ""
    if isinstance(value, int):
        return f'<c r="{ref}"{s}><v>{value}</v></c>'
    text = escape(_XML_BAD.sub("", value))
    return f'<c r="{ref}" t="inlineStr"{s}><is><t xml:space="preserve">{text}</t></is></c>'


def _column(n: int) -> str:
    name = ""
    while True:
        n, rest = divmod(n, 26)
        name = chr(65 + rest) + name
        if n == 0:
            return name
        n -= 1


def bom_xlsx(project: Project) -> bytes:
    """A minimal Office Open XML workbook (one sheet, bold header, column widths)."""
    rows: list[list[str | int]] = [list(COLUMNS), *(r.cells() for r in bom_rows(project))]
    xml_rows = []
    for r, cells in enumerate(rows, start=1):
        style = 1 if r == 1 else 0
        body = "".join(_cell(f"{_column(c)}{r}", v, style) for c, v in enumerate(cells))
        xml_rows.append(f'<row r="{r}">{body}</row>')
    widths = [max(len(str(row[c])) for row in rows) for c in range(len(COLUMNS))]
    cols = "".join(f'<col min="{c + 1}" max="{c + 1}" width="{min(max(w, 6), 60) + 2}" '
                   'customWidth="1"/>' for c, w in enumerate(widths))  # fmt: skip
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    files = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" '
            'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{rel}/officeDocument" Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook {ns} '
            f'xmlns:r="{rel}"><sheets><sheet name="BOM" sheetId="1" r:id="rId1"/></sheets>'
            "</workbook>"
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{rel}/worksheet" Target="worksheets/sheet1.xml"/>'
            f'<Relationship Id="rId2" Type="{rel}/styles" Target="styles.xml"/>'
            "</Relationships>"
        ),
        "xl/styles.xml": (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet {ns}>'
            '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
            '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
            '<fills count="2"><fill><patternFill patternType="none"/></fill>'
            '<fill><patternFill patternType="gray125"/></fill></fills>'
            '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border>'
            '</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" '
            'borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" '
            'fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" '
            'borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'
        ),
        "xl/worksheets/sheet1.xml": (
            f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet {ns}>'
            f"<cols>{cols}</cols><sheetData>{''.join(xml_rows)}</sheetData></worksheet>"
        ),
    }
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in files.items():
            archive.writestr(name, text)
    return out.getvalue()
