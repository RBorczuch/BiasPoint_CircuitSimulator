"""Compact text forms of graphs for AI agents (MCP), plus automatic placement of nodes."""

from bpt.document.model import Graph, GraphEdge, GraphNode

from .catalog import CATALOG, input_sockets, output_sockets
from .executor import NodeState

COLUMN, ROW = 380.0, 280.0


def auto_layout(graph: Graph) -> Graph:
    """Place nodes in columns by dependency depth (sources left, views right)."""
    depth: dict[str, int] = {n.id: 0 for n in graph.nodes}
    for _ in range(len(graph.nodes)):
        changed = False
        for edge in graph.edges:
            if (
                edge.source in depth
                and edge.target in depth
                and depth[edge.target] <= depth[edge.source]
            ):
                depth[edge.target] = depth[edge.source] + 1
                changed = True
        if not changed:
            break
    rows: dict[int, int] = {}
    nodes: list[GraphNode] = []
    for node in graph.nodes:
        column = depth[node.id]
        row = rows.get(column, 0)
        rows[column] = row + 1
        nodes.append(node.model_copy(update={"pos": (column * COLUMN, row * ROW)}))
    return graph.model_copy(update={"nodes": nodes})


def parse_link(text: str) -> tuple[str, str]:
    """``"tran.run"`` -> ("tran", "run")."""
    node, _, socket = text.strip().rpartition(".")
    if not node or not socket:
        raise ValueError(f"expected node.socket, got {text!r}")
    return node, socket


def make_edge(graph: Graph, source: str, target: str) -> GraphEdge:
    """Edge from ``"node.output"`` to ``"node.input"``; checks that both sockets exist."""
    (src, output), (dst, input_) = parse_link(source), parse_link(target)
    nodes = {n.id: n for n in graph.nodes}
    for node_id, socket, side in ((src, output, "outputs"), (dst, input_, "inputs")):
        if node_id not in nodes:
            raise ValueError(f"no node {node_id!r}")
        node_type = CATALOG.get(nodes[node_id].type)
        sockets = (
            (output_sockets(node_type, nodes[node_id].params) if side == "outputs"
             else input_sockets(node_type, nodes[node_id].param_inputs)) if node_type else []
        )  # fmt: skip
        names = [s.name for s in sockets]
        if socket not in names:
            raise ValueError(
                f"{node_id} ({nodes[node_id].type}) has no {side[:-1]} {socket!r}; has {names}"
            )
    return GraphEdge(source=src, output=output, target=dst, input=input_)


def catalog_text() -> str:
    lines = []
    for t in CATALOG.values():
        info = t.info
        ins = ", ".join(
            f"{s.name}:{s.type}{'*' if s.multi else ''}{'?' if s.optional else ''}"
            for s in info.inputs
        )
        outs = ", ".join(f"{s.name}:{s.type}" for s in info.outputs)
        if info.dynamic_outputs is not None:
            more = info.dynamic_outputs
            outs += f", one {more.type} per {more.param} item after the first {more.skip}"
        params = ", ".join(
            f"{p.name}={p.default!r}" + (f" ({'|'.join(p.options)})" if p.options else "")
            for p in info.params
        )
        lines.append(
            f"{info.type} - {info.title}: in [{ins}] → out [{outs}]"
            + (f"; params {params}" if params else "")
        )
        lines.append(f"    {info.description}")
    lines.append("Types: value = signal or scalar; * = several links; ? = optional.")
    return "\n".join(lines)


def graph_text(graph: Graph, states: dict[str, NodeState] | None = None) -> str:
    states = states or {}
    lines = [f"graph {graph.name!r}: {len(graph.nodes)} nodes, {len(graph.edges)} links"]
    for node in graph.nodes:
        params = ", ".join(f"{k}={v!r}" for k, v in node.params.items())
        state = states.get(node.id)
        status = (
            f" [{state.status}{': ' + state.error if state and state.error else ''}]"
            if state
            else ""
        )
        lines.append(f"  {node.id} = {node.type}({params}){status}")
        if state:
            lines += [f"      {line}" for line in state.summary[:4]]
    for edge in graph.edges:
        lines.append(f"  {edge.source}.{edge.output} -> {edge.target}.{edge.input}")
    return "\n".join(lines)
