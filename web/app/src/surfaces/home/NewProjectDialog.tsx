import { useState } from "react";
import { Dialog } from "../../components/dialogs/Dialog.tsx";
import { errorText } from "../../api/http.ts";
import { projectsApi, useProjects } from "../../projects/model.ts";
import { navigate } from "../../shell/router.ts";
import { toast } from "../../shell/toast.ts";

type Mode = "clone" | "empty";

/** The folder name a clone of `url` gets by default, as git would pick it. */
export function nameFromUrl(url: string): string {
  const tail = url.trim().replace(/[/\\]+$/, "").split(/[/:]/).pop() ?? "";
  return tail.replace(/\.git$/i, "");
}

/**
 * A new project: a Git repository cloned into the workspace, or an empty
 * folder. A clone is answered at once and runs in the background; its card
 * on Home shows git's progress and can stop it.
 */
export function NewProjectDialog({ initial = "clone", onClose }: { initial?: Mode; onClose(): void }) {
  const [mode, setMode] = useState<Mode>(initial);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setError(null);
    if (mode === "clone" && !url.trim()) return setError("Paste the repository's URL.");
    if (mode === "empty" && !name.trim()) return setError("Name the folder.");
    setBusy(true);
    try {
      if (mode === "clone") {
        const started = await projectsApi.clone(url.trim(), name.trim() || undefined);
        useProjects.getState().onClone({ ...started, kind: "project.clone", phase: "started" });
      } else {
        const project = await projectsApi.create(name.trim());
        await useProjects.getState().refresh();
        toast("success", `Made ${project.name}.`, undefined, {
          action: { label: "Open", run: () => navigate({ surface: "files", root: "workspace", rel: [project.name] }) },
        });
      }
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="New project"
      onClose={onClose}
      onSubmit={() => void submit()}
      submitLabel={mode === "clone" ? "Clone" : "Create folder"}
      submitDisabled={busy}
    >
      <div className="segmented is-wide" role="radiogroup" aria-label="Kind of project">
        <button
          role="radio"
          aria-checked={mode === "clone"}
          className={`segmented-btn${mode === "clone" ? " is-active" : ""}`}
          onClick={() => setMode("clone")}
        >
          Clone a repository
        </button>
        <button
          role="radio"
          aria-checked={mode === "empty"}
          className={`segmented-btn${mode === "empty" ? " is-active" : ""}`}
          onClick={() => setMode("empty")}
        >
          Empty folder
        </button>
      </div>
      {mode === "clone" && (
        <label className="field">
          <span className="field-label">Repository URL</span>
          <input
            className="input"
            value={url}
            data-autofocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="https://github.com/you/repo.git"
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
          />
          <span className="field-hint">https, ssh, git or user@host:path. Keys and credentials in the sandbox are used as they are.</span>
        </label>
      )}
      <label className="field">
        <span className="field-label">{mode === "clone" ? "Folder name" : "Name"}</span>
        <input
          className="input"
          value={name}
          data-autofocus={mode === "empty" ? "" : undefined}
          spellCheck={false}
          placeholder={mode === "clone" ? nameFromUrl(url) || "Taken from the URL" : "my-project"}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
        />
        <span className="field-hint">A folder at the top of the workspace.</span>
      </label>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
