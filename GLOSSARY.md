# Uzina

This glossary resolves the domain language used by the single-factory application and its execution boundary.

## Factory and execution

**Factory**:
The application-managed space for projects, participants, work, and execution resources.
_Avoid_: Tenant

**Controller**:
The authority that accepts coordination commands for one deployment.
_Avoid_: Instance

**Execution node**:
A registered machine that supplies explicitly assigned execution capabilities.
_Avoid_: Executor, agent

**Workspace**:
A checkout or working directory on a particular execution node.
_Avoid_: Project directory

## Work and transfer

**Work item**:
The root thread, relevant descendants, and workspace state that must travel together.
_Avoid_: Run

**Checkpoint**:
A versioned, coherent representation of supported runtime and workspace state.
_Avoid_: History export

**Ownership generation**:
A monotonically advancing fence identifying which owner may admit execution for transferred work.
_Avoid_: Epoch, version

**Command acceptance**:
The durable acknowledgement that an identified command was admitted; it does not mean its requested effect completed.
_Avoid_: Completion
