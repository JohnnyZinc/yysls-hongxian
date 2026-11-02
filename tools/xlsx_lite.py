# -*- coding: utf-8 -*-
"""
xlsx_lite.py — 零依赖 xlsx 读取器（仅标准库 zipfile + ElementTree），离线环境可用。

为什么需要：extract_calculator.py 原本依赖 openpyxl，而本机无网络无法安装第三方包。
本模块只实现提取器真正用到的那部分 openpyxl 表面：

    load_workbook(path, data_only=False) -> Workbook
      Workbook[name]              -> Worksheet
      Worksheet["G1"]             -> Cell
      Worksheet.cell(row, column) -> Cell
      Worksheet.max_row / max_column
      Cell.value                  -> 数值 / 字符串 / None（data_only=False 时公式返回 "=..."）
    get_column_letter(col)        -> "A" / "AA"

不在本模块职责内（提取器也没用到）：样式、合并单元格、日期格式、写入。
"""
import re
import zipfile
import xml.etree.ElementTree as ET

NS_MAIN = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
NS_REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
NS_PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"

_CELL_RE = re.compile(r"^([A-Z]+)(\d+)$")

# 相对引用的 A1 记号（用于共享公式平移）：前面不是 ! / 字母数字（排除 Sheet1!A1、函数名尾巴），
# 后面不是 ( 或 !（排除 LOG10( 、L:L 之类的误伤）
_REF_RE = re.compile(r"(?<![\w!$])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(!])")


def get_column_letter(col):
    s = ""
    while col > 0:
        col, rem = divmod(col - 1, 26)
        s = chr(65 + rem) + s
    return s


def _col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def _to_number(text):
    try:
        return int(text)
    except ValueError:
        pass
    try:
        return float(text)
    except ValueError:
        return text


def _translate(formula, dr, dc):
    """把 master 公式按 (dr,dc) 平移相对引用（Excel 共享公式的语义）。"""
    def repl(m):
        dc_lock, col, dr_lock, row = m.group(1), m.group(2), m.group(3), int(m.group(4))
        new_col = col if dc_lock else get_column_letter(_col_index(col) + dc)
        new_row = row if dr_lock else row + dr
        return f"{dc_lock}{new_col}{dr_lock}{new_row}"
    return _REF_RE.sub(repl, formula)


class Cell:
    __slots__ = ("value",)

    def __init__(self, value=None):
        self.value = value


class Worksheet:
    def __init__(self, grid, max_row, max_column):
        self._grid = grid  # (row, col) -> value
        self.max_row = max_row
        self.max_column = max_column

    def cell(self, row, column):
        return Cell(self._grid.get((row, column)))

    def __getitem__(self, coord):
        m = _CELL_RE.match(coord)
        if not m:
            raise KeyError(coord)
        return self.cell(int(m.group(2)), _col_index(m.group(1)))


class Workbook:
    def __init__(self, sheets):
        self._sheets = sheets

    @property
    def sheetnames(self):
        return list(self._sheets)

    def __getitem__(self, name):
        return self._sheets[name]


def _read_shared_strings(z):
    try:
        raw = z.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(raw)
    out = []
    for si in root.findall(f"{NS_MAIN}si"):
        # 拼接所有 <t>（富文本会被切成多个 run）；忽略 rPh 注音（读取场景无意义）
        out.append("".join(t.text or "" for t in si.iter(f"{NS_MAIN}t")))
    return out


def _sheet_targets(z):
    """sheet 名 -> xl/worksheets/sheetN.xml"""
    rels = {}
    root = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    for rel in root:
        rels[rel.get("Id")] = rel.get("Target")
    wbx = ET.fromstring(z.read("xl/workbook.xml"))
    out = {}
    for sh in wbx.iter(f"{NS_MAIN}sheet"):
        target = rels.get(sh.get(f"{NS_REL}id"))
        if not target:
            continue
        target = target.lstrip("/")
        if not target.startswith("xl/"):
            target = "xl/" + target
        out[sh.get("name")] = target
    return out


def _parse_sheet(z, target, shared, data_only):
    # 第一遍：收集原始单元格（共享公式的 master 可能出现在任何位置，先收齐再解析）
    raw_cells = []
    masters = {}  # si -> (anchor_row, anchor_col, formula_text)
    with z.open(target) as fh:
        for event, el in ET.iterparse(fh, events=("end",)):
            if el.tag != f"{NS_MAIN}row":
                continue
            for c in el.findall(f"{NS_MAIN}c"):
                ref = c.get("r")
                m = _CELL_RE.match(ref) if ref else None
                if not m:
                    continue
                r, col = int(m.group(2)), _col_index(m.group(1))
                f = c.find(f"{NS_MAIN}f")
                v = c.find(f"{NS_MAIN}v")
                is_el = c.find(f"{NS_MAIN}is")
                raw = None
                if v is not None:
                    raw = v.text
                elif is_el is not None:
                    raw = "".join(t.text or "" for t in is_el.iter(f"{NS_MAIN}t"))
                ftext = f.text if f is not None else None
                si = f.get("si") if f is not None else None
                is_shared = f is not None and f.get("t") == "shared"
                if is_shared and ftext:
                    fref = f.get("ref")
                    am = _CELL_RE.match(fref.split(":")[0]) if fref else None
                    ar, ac = (int(am.group(2)), _col_index(am.group(1))) if am else (r, col)
                    masters[si] = (ar, ac, ftext)
                raw_cells.append((r, col, c.get("t"), f is not None, ftext, si, is_shared, raw))
            el.clear()

    # 第二遍：按 data_only 语义取值
    grid = {}
    max_row = max_col = 0
    for r, col, ctype, has_f, ftext, si, is_shared, raw in raw_cells:
        # 共享公式跟随者：按 master 锚点平移（master 可能在后，故放到第二遍再解）
        if is_shared and not ftext and si in masters:
            ar, ac, text = masters[si]
            ftext = _translate(text, r - ar, col - ac)
        if data_only:
            if raw is None:
                val = None
            elif ctype == "s":
                val = shared[int(raw)] if raw.isdigit() else raw
            elif ctype == "b":
                val = raw == "1"
            elif ctype in ("str", "e"):
                val = raw  # 公式字符串结果 / 错误值原样保留
            else:
                val = _to_number(raw)
        elif has_f:
            val = "=" + (ftext or "")
        elif raw is None:
            val = None
        elif ctype == "s":
            val = shared[int(raw)] if raw.isdigit() else raw
        elif ctype == "str":
            val = raw
        else:
            val = _to_number(raw)
        if val is not None:
            grid[(r, col)] = val
            if r > max_row:
                max_row = r
            if col > max_col:
                max_col = col
    return grid, max_row, max_col


def load_workbook(path, data_only=False):
    z = zipfile.ZipFile(path)
    shared = _read_shared_strings(z)
    sheets = {}
    for name, target in _sheet_targets(z).items():
        grid, mr, mc = _parse_sheet(z, target, shared, data_only)
        sheets[name] = Worksheet(grid, mr, mc)
    return Workbook(sheets)
