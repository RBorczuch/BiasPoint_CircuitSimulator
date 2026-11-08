"""Command line interface: ``bpt``."""

import json
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

from bpt import APP_NAME, __version__
from bpt.config import DEFAULT_HOST, DEFAULT_PORT, LOOPBACK_HOSTS

if TYPE_CHECKING:
    from bpt.netlist.ir import CircuitIR, Device

app = typer.Typer(name="bpt", help=f"{APP_NAME} circuit simulator backend.", no_args_is_help=True)


@app.command()
def serve(
    host: Annotated[str, typer.Option(help="Loopback address to bind.")] = DEFAULT_HOST,
    port: Annotated[int, typer.Option(help="TCP port.")] = DEFAULT_PORT,
    dev: Annotated[bool, typer.Option(help="Allow the Vite dev server origin.")] = False,
    reload: Annotated[
        bool, typer.Option(help="Restart on code changes (needs a console on Windows).")
    ] = False,
) -> None:
    """Run the backend API server."""
    import uvicorn

    from bpt.api.security import create_session
    from bpt.app import create_app

    if host not in LOOPBACK_HOSTS:
        raise typer.BadParameter("only loopback addresses are allowed", param_hint="--host")
    session = create_session(host, port)
    typer.echo(f"{APP_NAME} {__version__} on {session.base_url} (dev={dev}, reload={reload})")
    if reload:
        # uvicorn restarts workers with CTRL_C_EVENT on Windows, which never arrives in a
        # process without a console (e.g. started in the background by a tool).
        uvicorn.run(
            "bpt.app:dev_app" if dev else "bpt.app:session_app",
            factory=True,
            reload=True,
            reload_dirs=[str(Path(__file__).parent)],
            host=host,
            port=port,
            timeout_graceful_shutdown=2,
        )
    else:
        app_ = create_app(session, dev=dev)
        uvicorn.run(app_, host=host, port=port, log_level="info", timeout_graceful_shutdown=2)


@app.command()
def info() -> None:
    """Print versions of the backend, the native module and ngspice."""
    from bpt.api.system import health

    typer.echo(json.dumps(health().model_dump(), indent=2))


@app.command()
def openapi(
    output: Annotated[Path | None, typer.Option(help="Write to file instead of stdout.")] = None,
) -> None:
    """Print the OpenAPI schema (used to generate frontend types)."""
    from bpt.api.security import Session
    from bpt.app import create_app

    schema = create_app(Session(DEFAULT_HOST, DEFAULT_PORT, "unused")).openapi()
    text = json.dumps(schema, indent=2) + "\n"
    if output is None:
        typer.echo(text, nl=False)
    else:
        output.write_text(text, encoding="utf-8", newline="\n")


def _default_store() -> Path:
    from platformdirs import user_cache_path

    return user_cache_path(APP_NAME, appauthor=False) / "runs"


StoreOption = Annotated[Path | None, typer.Option(help="Result store directory.")]


@app.command()
def sim(
    netlist: Annotated[Path, typer.Argument(exists=True, dir_okay=False, help="SPICE netlist.")],
    analysis: Annotated[
        list[str] | None,
        typer.Option(
            "--analysis", "-a", help='Analysis card overriding the netlist, e.g. ".tran 10u 5m".'
        ),
    ] = None,
    signal: Annotated[
        list[str] | None, typer.Option("--signal", "-s", help="Only summarize these signals.")
    ] = None,
    store: StoreOption = None,
) -> None:
    """Simulate a SPICE netlist with ngspice and print a summary of each analysis."""
    from bpt.engines.ngspice.engine import NgspiceEngine
    from bpt.netlist.spice_parser import SpiceSyntaxError, parse_netlist
    from bpt.results.store import ResultStore
    from bpt.results.summary import summarize

    text = netlist.read_text(encoding="utf-8")
    try:
        parsed = parse_netlist(text)
        if analysis:
            parsed.analyses = parse_netlist("override\n" + "\n".join(analysis)).analyses
    except SpiceSyntaxError as exc:
        raise typer.BadParameter(str(exc)) from exc
    if not parsed.analyses:
        raise typer.BadParameter("no analysis in the netlist; add e.g. --analysis .op")
    parsed.circuit.devices = _with_parasitics(parsed.circuit)
    results = ResultStore(store or _default_store())
    engine = NgspiceEngine()
    failed = False
    try:
        for spec in parsed.analyses:
            meta = engine.run(parsed.circuit, spec, results)
            failed |= meta.status != "ok"
            typer.echo(summarize(results.open(meta.run_id), signal))
            typer.echo(f"run_id: {meta.run_id}\n")
    finally:
        engine.close()
    if failed:
        raise typer.Exit(code=1)


@app.command()
def export(
    run_id: Annotated[str, typer.Argument(help="Run id printed by `bpt sim`.")],
    csv: Annotated[Path, typer.Option(help="Output CSV file.")],
    signal: Annotated[list[str] | None, typer.Option("--signal", "-s")] = None,
    store: StoreOption = None,
) -> None:
    """Export a run to CSV."""
    from bpt.io.csv_export import export_csv
    from bpt.results.store import ResultStore

    export_csv(ResultStore(store or _default_store()).open(run_id), csv, signal)
    typer.echo(f"wrote {csv}")


@app.command()
def schema(
    out: Annotated[Path, typer.Option(help="Output directory.")] = Path("../schemas"),
) -> None:
    """Write JSON Schemas of the file formats (generated from the Pydantic models)."""
    from pydantic import BaseModel

    from bpt.document.model import Graph, Project, Sheet
    from bpt.library.symbols import Symbol

    models: dict[str, type[BaseModel]] = {
        "project": Project,
        "sheet": Sheet,
        "graph": Graph,
        "symbol": Symbol,
    }
    out.mkdir(parents=True, exist_ok=True)
    for name, model in models.items():
        text = json.dumps(model.model_json_schema(), indent=2) + "\n"
        (out / f"{name}.schema.json").write_text(text, encoding="utf-8", newline="\n")
    typer.echo(f"wrote {len(models)} schemas to {out}")


@app.command()
def examples(
    out: Annotated[Path, typer.Option(help="Output directory.")] = Path("../examples"),
) -> None:
    """Write the example projects (one ``<name>.bpt`` folder each)."""
    from bpt.examples import write_examples

    for path in write_examples(out):
        typer.echo(f"wrote {path}")


def main() -> None:
    app()


if __name__ == "__main__":
    main()


def _with_parasitics(circuit: "CircuitIR") -> "list[Device]":
    """Non-ideal parts of a netlist (LTspice ``Rser=`` -> ESR...) as extra elements, as the
    netlister does for a project (ngspice would ignore the parameters)."""
    from bpt.document.builder import BuildError, symbol_for
    from bpt.library.builtin import builtin_symbols
    from bpt.netlist.netlister import expand_parasitics

    symbols = builtin_symbols()
    out = []
    for device in circuit.devices:
        try:
            symbol = symbols[symbol_for(device, circuit)]
        except (BuildError, KeyError):
            out.append(device)
            continue
        out += expand_parasitics(device, symbol)
    return out
