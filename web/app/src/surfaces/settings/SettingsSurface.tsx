import { useEffect, useState } from "react";
import { useEditorFollowsTheme } from "../../theme/editorSync.ts";
import { useCopyOnSelect } from "../../terminal/clipboard.ts";
import { BookOpen, Info, Keyboard, KeyRound, Laptop, Monitor, Moon, Palette, Share2, Sun, type LucideIcon } from "lucide-react";
import { useApp } from "../../store/app.ts";
import type { Theme } from "../../theme/useTheme.ts";
import { useSystem } from "../../system/model.ts";
import { PageHeader, Section } from "../../components/ui/Page.tsx";
import { openKeymap } from "../../shell/actions.ts";
import { useRouter } from "../../shell/router.ts";
import type { SettingsSection } from "../../shell/routes.ts";
import { gateApi } from "../../settings/gate.ts";
import { AccountSection } from "./AccountSection.tsx";
import { DevicesSection } from "./DevicesSection.tsx";
import { SharingSection } from "./SharingSection.tsx";

const SECTIONS: { id: SettingsSection; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "account", label: "Account", icon: KeyRound, hint: "Password, two-factor, sessions" },
  { id: "cli", label: "Devices & CLI", icon: Laptop, hint: "The agentbox command, device sign-ins" },
  { id: "sharing", label: "Sharing", icon: Share2, hint: "Public apps, default expiry" },
  { id: "appearance", label: "Appearance", icon: Palette, hint: "Light, dark or the system's" },
  { id: "about", label: "About", icon: Info, hint: "Versions and help" },
];

const THEMES: { id: Theme; label: string; icon: LucideIcon; hint: string }[] = [
  { id: "system", label: "System", icon: Monitor, hint: "Follows your device" },
  { id: "light", label: "Light", icon: Sun, hint: "Always light" },
  { id: "dark", label: "Dark", icon: Moon, hint: "Always dark" },
];

function AppearanceSection() {
  const theme = useApp((s) => s.ui.theme);
  const themeSet = useApp((s) => s.themeSet);
  return (
    <Section title="Theme" id="theme">
      <div className="theme-choices" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => {
          const Icon = t.icon;
          const on = theme === t.id;
          return (
            <button
              key={t.id}
              role="radio"
              aria-checked={on}
              className={`theme-choice${on ? " is-active" : ""}`}
              onClick={() => themeSet?.(t.id)}
            >
              <span className={`theme-swatch is-${t.id}`} aria-hidden="true">
                <span className="theme-swatch-rail" />
                <span className="theme-swatch-body">
                  <span />
                  <span />
                </span>
              </span>
              <span className="theme-choice-label">
                <Icon size={14} aria-hidden="true" />
                {t.label}
              </span>
              <span className="theme-choice-hint">{t.hint}</span>
            </button>
          );
        })}
      </div>
      <p className="field-hint">Kept in this browser. The terminals follow it too.</p>
      <EditorFollows />
      <CopyOnSelect />
    </Section>
  );
}

/** Whether selecting text in a terminal copies it straight away. */
function CopyOnSelect() {
  const on = useCopyOnSelect((s) => s.on);
  const set = useCopyOnSelect((s) => s.set);
  return (
    <div className="settings-card editor-follows">
      <div className="settings-row">
        <div className="settings-row-text">
          <strong id="copy-on-select-label">Terminals copy what you select</strong>
          <span id="copy-on-select-hint">
            As herdr does. Off, copy with Ctrl+Shift+C (⌘C on a Mac) or the right-click menu. Kept in this browser.
          </span>
        </div>
        <button
          className={`switch${on ? " is-on" : ""}`}
          role="switch"
          aria-checked={on}
          aria-labelledby="copy-on-select-label"
          aria-describedby="copy-on-select-hint"
          onClick={() => set(!on)}
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

/** Whether VS Code switches between light and dark with the app. */
function EditorFollows() {
  const on = useEditorFollowsTheme((s) => s.on);
  const set = useEditorFollowsTheme((s) => s.set);
  return (
    <div className="settings-card editor-follows">
      <div className="settings-row">
        <div className="settings-row-text">
          <strong id="editor-follows-label">Editor follows the app's theme</strong>
          <span id="editor-follows-hint">
            VS Code turns light or dark with the app, unless you pick a theme of your own there. It is one editor for the box: the last device to change
            theme sets it.
          </span>
        </div>
        <button
          className={`switch${on ? " is-on" : ""}`}
          role="switch"
          aria-checked={on}
          aria-labelledby="editor-follows-label"
          aria-describedby="editor-follows-hint"
          onClick={() => set(!on)}
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function AboutSection() {
  const info = useSystem((s) => s.info);
  const [gate, setGate] = useState<string | null>(null);
  useEffect(() => {
    if (!info) void useSystem.getState().refresh();
    gateApi
      .version()
      .then((v) => setGate(v.version))
      .catch(() => {});
  }, [info]);
  const rows: [string, string | null | undefined][] = [
    ["agentbox", info?.versions.agentbox],
    ["The gate", gate],
    ["herdr", info?.versions.herdr],
    ["code-server", info?.versions.codeServer],
    ["Node.js", info?.versions.node],
  ];
  return (
    <>
      <Section title="Versions" id="versions">
        <dl className="props">
          {rows.map(([k, v]) => (
            <div className="prop" key={k}>
              <dt>{k}</dt>
              <dd className="mono">{v ?? "—"}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <Section title="Help" id="help">
        <div className="settings-card">
          <div className="settings-row">
            <span className="settings-glyph" aria-hidden="true">
              <Keyboard size={16} />
            </span>
            <div className="settings-row-text">
              <strong>Keyboard shortcuts</strong>
              <span>Every surface, the palette, the dock and the Workbench's prefix keys.</span>
            </div>
            <button className="btn btn-small" onClick={openKeymap}>
              Show
            </button>
          </div>
          <div className="settings-row">
            <span className="settings-glyph" aria-hidden="true">
              <BookOpen size={16} />
            </span>
            <div className="settings-row-text">
              <strong>Documentation</strong>
              <span>Installing, signing in, the app, apps and sharing, and the security model.</span>
            </div>
            <a className="btn btn-small" href="https://github.com/jabezpauls/agentbox#readme" target="_blank" rel="noopener noreferrer">
              Open
            </a>
          </div>
        </div>
      </Section>
    </>
  );
}

/**
 * Settings: Account, Devices & CLI, Sharing, Appearance and About — a list
 * of sections beside the one open, or a row of them above it on a phone.
 */
export function SettingsSurface() {
  const route = useRouter((s) => s.route);
  const navigate = useRouter((s) => s.navigate);
  const [section, setSection] = useState<SettingsSection>(route.surface === "settings" ? route.section : "account");
  useEffect(() => {
    if (route.surface === "settings") setSection(route.section);
  }, [route]);
  const meta = SECTIONS.find((s) => s.id === section)!;

  return (
    <div className="page settings">
      <div className="page-inner settings-inner">
        <nav className="settings-nav" aria-label="Settings">
          <h1 className="page-title settings-title">Settings</h1>
          <ul>
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const on = s.id === section;
              return (
                <li key={s.id}>
                  <a
                    href={`/settings/${s.id}`}
                    className={`settings-nav-item${on ? " is-active" : ""}`}
                    aria-current={on ? "page" : undefined}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      e.preventDefault();
                      navigate({ surface: "settings", section: s.id });
                    }}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span>{s.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="settings-body">
          <PageHeader title={meta.label} subtitle={meta.hint} id="settings-heading" />
          {section === "account" && <AccountSection />}
          {section === "cli" && <DevicesSection />}
          {section === "sharing" && <SharingSection />}
          {section === "appearance" && <AppearanceSection />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
