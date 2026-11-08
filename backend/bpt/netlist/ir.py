"""Engine-independent circuit representation (IR).

Produced by the netlister (from a project) or the SPICE parser (from a netlist file) and
consumed by engine-specific writers.
"""

from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from bpt.document.model import ModelCard, SubcktModel
from bpt.library.symbols import ElementKind


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Device(_Base):
    ref: str  # name shown to the user (R1, U3)
    element: ElementKind
    nodes: list[str]  # SPICE node names, "0" = ground
    params: dict[str, str] = Field(default_factory=dict)
    model: str | None = None
    instance_id: UUID | None = None

    @property
    def spice_name(self) -> str:
        """SPICE requires the element letter as the first character of the name."""
        if self.ref[:1].upper() == self.element:
            return self.ref
        return f"{self.element}{self.ref}"


class Subcircuit(_Base):
    """A hierarchical sheet as ``.subckt name ports``; blocks use it as ``X`` elements."""

    name: str
    ports: list[str]  # SPICE nodes inside, in the block's pin order
    params: dict[str, str] = Field(default_factory=dict)  # defaults: ``params: R=1k``
    devices: list[Device] = Field(default_factory=list)
    directives: list[str] = Field(default_factory=list)  # .param / .func / .model of the sheet
    net_names: dict[str, str] = Field(default_factory=dict)  # SPICE node -> user net name


class CircuitIR(_Base):
    title: str = "BiasPoint circuit"
    devices: list[Device] = Field(default_factory=list)
    models: dict[str, ModelCard] = Field(default_factory=dict)
    parameters: dict[str, str] = Field(default_factory=dict)
    directives: list[str] = Field(default_factory=list)
    net_names: dict[str, str] = Field(default_factory=dict)  # SPICE node -> user net name
    subcircuits: list[Subcircuit] = Field(default_factory=list)  # hierarchical sheets
    globals: list[str] = Field(default_factory=list)  # nodes shared with subcircuits (.global)
    subckt_models: dict[str, SubcktModel] = Field(default_factory=dict)  # device models used
    save_currents: bool = True  # False: node voltages and source currents only (big runs)

    def device(self, ref: str) -> Device:
        for device in self.devices:
            if device.ref.lower() == ref.lower():
                return device
        raise KeyError(f"no device {ref!r}")
