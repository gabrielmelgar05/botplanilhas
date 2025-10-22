from fastapi import FastAPI, UploadFile, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Optional, List
import pandas as pd
import io, os, json, re, unicodedata, uuid
from datetime import datetime

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Content-Disposition", "X-Run-Summary", "X-Session-Id"],
)

OUTPUT_DIR = "outputs"
SESSIONS_DIR = os.path.join(OUTPUT_DIR, "sessions")
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(SESSIONS_DIR, exist_ok=True)

ALLOWED_EXTS = {".csv", ".xlsx"}
ALLOWED_DESC = "Tipos aceitos: CSV (.csv) e Excel (.xlsx)."

def norm_col(s: str) -> str:
    s = s.strip().lower()
    s = ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')
    s = re.sub(r'[^a-z0-9]+', '_', s)
    return s.strip('_')

def get_ext(filename: str) -> str:
    m = re.search(r'(\.[a-zA-Z0-9]+)$', filename or "")
    return m.group(1).lower() if m else ""

def ensure_allowed(file: UploadFile):
    ext = get_ext(file.filename or "")
    if ext not in ALLOWED_EXTS:
        raise HTTPException(415, f"Arquivo '{file.filename}' não é compatível. {ALLOWED_DESC}")

def read_table(file: UploadFile, sheet: Optional[str]) -> pd.DataFrame:
    ensure_allowed(file)
    content = file.file.read()
    file.file.seek(0)
    name = file.filename or ""
    if name.lower().endswith(".csv"):
        df = pd.read_csv(io.BytesIO(content), dtype=str, encoding="utf-8", sep=None, engine="python")
    else:
        df = pd.read_excel(io.BytesIO(content), sheet_name=sheet if sheet else 0, dtype=str, engine="openpyxl")
    df.columns = [norm_col(c) for c in df.columns]
    for c in df.columns:
        df[c] = df[c].astype(str).str.strip()
    return df

def detect_key(df_a: pd.DataFrame, df_b: pd.DataFrame, forced_key: Optional[str]=None) -> str:
    if forced_key and forced_key in df_a.columns and forced_key in df_b.columns:
        return forced_key
    candidates = ["id","id_usuario","nome","cpf","email","usuario","nome_do_usuario"]
    for k in candidates:
        if k in df_a.columns and k in df_b.columns:
            return k
    inter = [c for c in df_a.columns if c in df_b.columns]
    if inter:
        return inter[0]
    raise HTTPException(400, "Não foi possível detectar a chave de junção; indique no prompt (ex.: 'por nome').")

def detect_added_columns(df_src: pd.DataFrame, prompt: str) -> List[str]:
    cols = []
    if re.search(r'\bcpf\b', prompt, flags=re.I) and 'cpf' in df_src.columns:
        cols.append('cpf')
    return cols

def parse_action(prompt: str, tables: Dict[str, pd.DataFrame]) -> str:
    text = prompt.lower()
    if len(tables) == 1 or re.search(r'\b(ordenar|classificar|sort|orden(e|ar)|order by)\b', text):
        return "SORT"
    return "MERGE"

def choose_table_from_prompt(prompt: str, aliases: Dict[str, str], tables: Dict[str, pd.DataFrame], fallback: str) -> str:
    text = prompt.lower()
    mentioned = [a for a in aliases.values() if a and re.search(rf'\b{re.escape(a.lower())}\b', text)]
    for a in mentioned:
        if a in tables:
            return a
    return fallback

def choose_columns_from_prompt(prompt: str, df: pd.DataFrame) -> List[str]:
    text = prompt.lower()
    candidates = []
    for c in df.columns:
        if re.search(rf'\b{re.escape(c)}\b', text):
            candidates.append(c)
    if candidates:
        return candidates
    for pref in ["nome", "id_usuario", "id", "cpf"]:
        if pref in df.columns:
            return [pref]
    return [df.columns[0]]

def sort_direction(prompt: str) -> str:
    text = prompt.lower()
    if re.search(r'\b(desc|decresc|maior\s+para\s+menor)\b', text):
        return "desc"
    return "asc"

def parse_prompt_for_merge(prompt: str, aliases: Dict[str,str], tables: Dict[str,pd.DataFrame]) -> Dict:
    text = prompt.lower()
    mentioned = [a for a in aliases.values() if a and re.search(rf'\b{re.escape(a.lower())}\b', text)]

    # destino
    m_dest = re.search(r'(na|para|em)\s+([a-z0-9_]+)', text)
    dest = None
    if m_dest:
        cand = m_dest.group(2)
        if cand in tables:
            dest = cand
    if not dest:
        dest = mentioned[0] if mentioned and mentioned[0] in tables else list(tables.keys())[0]

    # origem
    m_src = re.search(r'(da|de)\s+([a-z0-9_]+)', text)
    src = None
    if m_src:
        cand = m_src.group(2)
        if cand in tables:
            src = cand
    if not src:
        src = mentioned[1] if len(mentioned) > 1 and mentioned[1] in tables else (list(tables.keys())[1] if len(tables)>1 else None)
    if not src:
        raise HTTPException(400, "Não foi possível identificar a planilha de origem.")

    # chave
    key = None
    if re.search(r'por\s+nome|pel[oa]s?\s+nomes?', text): key = 'nome'
    if re.search(r'por\s+cpf', text): key = 'cpf'
    if re.search(r'por\s+id(_usuario)?\b', text): key = 'id_usuario' if 'id_usuario' in tables[dest].columns else 'id'
    key = detect_key(tables[dest], tables[src], key)

    # colunas a trazer
    add_cols = detect_added_columns(tables[src], prompt)
    if not add_cols:
        add_cols = [c for c in tables[src].columns if c != key][:10]

    # fill missing
    fill_missing = None
    m_fill = re.search(r'(se|caso).+?nao\s+tenha.*?(coloc[ae]|preench[ae]).*?["“](.+?)["”]', text)
    if m_fill:
        fill_missing = m_fill.group(3).strip()
    if 'sem cpf' in text:
        fill_missing = 'SEM CPF'

    return {"action":"MERGE","dest":dest,"src":src,"key":key,"add_cols":add_cols,"fill_missing":fill_missing}

def append_session_event(session_id: str, event: Dict):
    path = os.path.join(SESSIONS_DIR, f"{session_id}.jsonl")
    event["ts"] = datetime.utcnow().isoformat() + "Z"
    with open(path, "a", encoding="utf-8") as fp:
        fp.write(json.dumps(event, ensure_ascii=False) + "\n")

# -------------------- Endpoints -------------------- #

@app.post("/process")
async def process(
    prompt: str = Form(...),
    aliases: str = Form(...),
    sheets: Optional[str] = Form(None),
    download: int = Form(0),              # 0 = JSON; 1 = arquivo direto
    out_format: str = Form("xlsx"),       # "xlsx" ou "csv"
    session_id: Optional[str] = Form(None),
    file1: UploadFile = None, file2: UploadFile = None, file3: UploadFile = None, file4: UploadFile = None, file5: UploadFile = None
):
    if not session_id:
        session_id = uuid.uuid4().hex

    try:
        aliases_map = json.loads(aliases) if aliases else {}
        sheets_map = json.loads(sheets) if sheets else {}
    except:
        raise HTTPException(400, "JSON inválido em aliases/sheets.")

    files = [f for f in [file1,file2,file3,file4,file5] if f]
    if len(files) < 1:
        raise HTTPException(400, "Envie pelo menos 1 planilha.")

    # ler tabelas
    tables: Dict[str, pd.DataFrame] = {}
    for idx, f in enumerate(files, start=1):
        alias = aliases_map.get(f"file{idx}", f"planilha_{idx}")
        sheet = sheets_map.get(f"file{idx}")
        df = read_table(f, sheet)
        tables[alias] = df

    # decidir ação
    action = parse_action(prompt, tables)

    # ---------- SORT: 1 arquivo ou pedido explícito de ordenação ----------
    if action == "SORT":
        dest_alias = choose_table_from_prompt(prompt, aliases_map, tables, list(tables.keys())[0])
        dest_df = tables[dest_alias].copy()
        cols = choose_columns_from_prompt(prompt, dest_df)
        direction = sort_direction(prompt)
        dest_sorted = dest_df.sort_values(by=cols, ascending=(direction == "asc"), kind="mergesort")

        # salvar
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        base_name = f"resultado_{timestamp}"
        if out_format == "csv":
            result_path = os.path.join(OUTPUT_DIR, f"{base_name}.csv")
            dest_sorted.to_csv(result_path, index=False)
            media_type = "text/csv"
            download_name = "planilhanova.csv"
        else:
            result_path = os.path.join(OUTPUT_DIR, f"{base_name}.xlsx")
            with pd.ExcelWriter(result_path, engine="openpyxl") as writer:
                dest_sorted.to_excel(writer, index=False, sheet_name="resultado")
            media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            download_name = "planilhanova.xlsx"

        summary = {
            "detected_action": "SORT",
            "destination": dest_alias,
            "source": "",
            "key": ",".join(cols),
            "added_columns": [],
            "fill_missing": None,
            "rows_total": int(len(dest_sorted)),
            "rows_unmatched": 0,
            "sort_order": direction
        }

        append_session_event(session_id, {
            "type":"run","prompt":prompt,"aliases":aliases_map,"summary":summary,
            "artifacts":{"result_path":result_path,"unmatched_url":None}
        })

        if download == 1:
            headers = {
                "X-Session-Id": session_id,
                "X-Run-Summary": json.dumps(summary, ensure_ascii=False)
            }
            return FileResponse(
                path=result_path,
                media_type=media_type,
                filename=download_name,
                headers=headers
            )

        return JSONResponse({
            "session_id": session_id,
            "summary": summary,
            "artifacts": {
                "result_url": f"/download/{os.path.basename(result_path)}",
                "unmatched_url": None,
                "log_url": None
            }
        })

    # ---------- MERGE: 2+ arquivos ----------
    if len(tables) < 2:
        raise HTTPException(400, "Para mesclar dados são necessárias pelo menos 2 planilhas.")

    spec = parse_prompt_for_merge(prompt, aliases_map, tables)
    dest = tables[spec["dest"]].copy()
    src  = tables[spec["src"]][[c for c in set([spec["key"]] + spec["add_cols"]) if c in tables[spec["src"]].columns]].copy()

    dest = dest.merge(src, on=spec["key"], how="left", suffixes=("", "_src"))

    unmatched = None
    if spec["fill_missing"] is not None:
        for c in spec["add_cols"]:
            if c in dest.columns:
                dest[c] = dest[c].fillna(spec["fill_missing"])
        mask_unmatched = True
        for c in spec["add_cols"]:
            if c in dest.columns:
                mask_unmatched = mask_unmatched & (dest[c] == spec["fill_missing"])
        unmatched = dest[mask_unmatched].copy()

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    base_name = f"resultado_{timestamp}"
    if out_format == "csv":
        result_path = os.path.join(OUTPUT_DIR, f"{base_name}.csv")
        dest.to_csv(result_path, index=False)
        media_type = "text/csv"
        download_name = "planilhanova.csv"
    else:
        result_path = os.path.join(OUTPUT_DIR, f"{base_name}.xlsx")
        with pd.ExcelWriter(result_path, engine="openpyxl") as writer:
            dest.to_excel(writer, index=False, sheet_name="resultado")
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        download_name = "planilhanova.xlsx"

    unmatched_url = None
    if unmatched is not None and len(unmatched) > 0:
        um_path = os.path.join(OUTPUT_DIR, f"linhas_sem_correspondencia_{timestamp}.csv")
        unmatched.to_csv(um_path, index=False)
        unmatched_url = f"/download/{os.path.basename(um_path)}"

    summary = {
        "detected_action": "MERGE",
        "destination": spec["dest"],
        "source": spec["src"],
        "key": spec["key"],
        "added_columns": spec["add_cols"],
        "fill_missing": spec["fill_missing"],
        "rows_total": int(len(dest)),
        "rows_unmatched": int(len(unmatched) if unmatched is not None else 0)
    }

    append_session_event(session_id, {
        "type":"run","prompt":prompt,"aliases":aliases_map,"summary":summary,
        "artifacts":{"result_path":result_path,"unmatched_url":unmatched_url}
    })

    if download == 1:
        headers = {
            "X-Session-Id": session_id,
            "X-Run-Summary": json.dumps(summary, ensure_ascii=False)
        }
        return FileResponse(
            path=result_path,
            media_type=media_type,
            filename=download_name,
            headers=headers
        )

    return JSONResponse({
        "session_id": session_id,
        "summary": summary,
        "artifacts": {
            "result_url": f"/download/{os.path.basename(result_path)}",
            "unmatched_url": unmatched_url,
            "log_url": None
        }
    })

@app.get("/download/{fname}")
def download(fname: str):
    path = os.path.join(OUTPUT_DIR, fname)
    if not os.path.exists(path):
        raise HTTPException(404, "Arquivo não encontrado.")
    # FileResponse já define Content-Length e o Content-Disposition correto
    return FileResponse(path)
