"""Open Tableau 2026 views in a form tableauscraper can parse.

Tableau's current viewer first creates a session with ``startSession`` and
then downloads the workbook bootstrap payload.  tableauscraper 0.1.29 still
expects the older HTML-embedded configuration, so this module performs the
two requests and hands the parsed payload to the library.
"""

from __future__ import annotations

import json
import re
from urllib.parse import urlparse

import requests
from tableauscraper import TableauScraper
from tableauscraper import utils


def load_tableau_workbook(url: str, *, delay_ms: int = 100):
    parsed = urlparse(url)
    parts = parsed.path.strip("/").split("/")
    if len(parts) < 3 or parts[0] != "views":
        raise ValueError(f"expected a Tableau /views/workbook/view URL, got {url}")
    workbook_name, view_name = parts[1], parts[2]
    host = f"{parsed.scheme}://{parsed.netloc}"

    session = requests.Session()
    location = url + ("&" if "?" in url else "?") + ":redirect=auth"
    start_url = (
        f"{host}/vizql/w/{workbook_name}/v/{view_name}"
        "/startSession/viewing?:embed=yes"
    )
    start = session.post(
        start_url,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Tableau-Viz-Location": location,
            "Tableau-Viz-Path": f"/w/{workbook_name}#0",
        },
        timeout=60,
    )
    start.raise_for_status()
    config = start.json()

    routing_key = start.headers.get("Global-Session-Header")
    if routing_key:
        session.headers["Global-Session-Header"] = routing_key

    bootstrap_url = (
        host
        + config["vizql_root"]
        + "/bootstrapSession/sessions/"
        + config["sessionid"]
    )
    bootstrap = session.post(
        bootstrap_url,
        data={
            "sheet_id": config["sheetId"],
            "clientDimension": json.dumps({"w": 1920, "h": 1080}),
        },
        timeout=60,
    )
    bootstrap.raise_for_status()
    match = re.search(r"\d+;({.*})\d+;({.*})", bootstrap.text, re.MULTILINE)
    if match is None:
        raise RuntimeError("Tableau bootstrap response has an unsupported format")

    scraper = TableauScraper(delayMs=delay_ms)
    scraper.session = session
    scraper.host = host
    scraper.tableauData = config
    scraper.info = json.loads(match.group(1))
    scraper.data = json.loads(match.group(2))
    scraper.dashboard = scraper.info["sheetName"]
    scraper.zones = {}

    pres_model_map = scraper.data["secondaryInfo"]["presModelMap"]
    scraper.dataSegments = pres_model_map["dataDictionary"]["presModelHolder"][
        "genDataDictionaryPresModel"
    ]["dataSegments"]
    scraper.parameters = utils.getParameterControlInput(scraper.info)
    scraper.filters = utils.getFiltersForAllWorksheet(
        scraper.logger,
        scraper.data,
        scraper.info,
        rootDashboard=scraper.dashboard,
    )
    return scraper, scraper.getWorkbook()
