import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  normalizePath,
  setIcon
} from "obsidian";

type ProfileState = "ON" | "OFF" | "UNINSTALLED" | "INVALID_JSON";

interface ProfileConfig {
  name: string;
  configDir: string;
}

interface PluginProfileManagerSettings {
  profiles: ProfileConfig[];
  uninstallBackupRetentionDays: number;
  privacyMode: boolean;
}

interface ManifestInfo {
  id: string;
  name: string;
  profileDirs: Set<string>;
}

interface ProfileSnapshot {
  profile: ProfileConfig;
  communityPath: string;
  rawCommunity: string | null;
  enabledIds: Set<string>;
  installedIds: Set<string>;
  installedPluginPaths: Map<string, string>;
  invalidJson: boolean;
  errorMessage: string | null;
}

interface ScanResult {
  profiles: ProfileSnapshot[];
  manifests: Map<string, ManifestInfo>;
}

interface ScrollSnapshot {
  top: number;
  left: number;
}

type DataRecord = Record<string, unknown>;

const DEFAULT_SETTINGS: PluginProfileManagerSettings = {
  profiles: [],
  uninstallBackupRetentionDays: 30,
  privacyMode: false
};

const PLUGIN_ID = "plugin-profile-manager";
const BACKUP_DIR = "backups/community-plugins";
const UNINSTALL_BACKUP_DIR = "backups/plugin-uninstall";

export default class PluginProfileManagerPlugin extends Plugin {
  settings: PluginProfileManagerSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("sliders-horizontal", "Open profile manager", () => {
      new PluginProfileManagerModal(this.app, this).open();
    });

    this.addCommand({
      id: "open-manager",
      name: "Open manager",
      callback: () => new PluginProfileManagerModal(this.app, this).open()
    });

    this.addSettingTab(new PluginProfileManagerSettingTab(this.app, this));
  }

  async loadSettings() {
    const data = toRecord(await this.loadData());
    const { demoMode: legacyDemoMode, ...cleanData } = data;
    const fallbackProfiles = getDefaultProfiles(this.app);
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...cleanData,
      profiles: sanitizeProfiles(data.profiles, fallbackProfiles),
      uninstallBackupRetentionDays: sanitizeRetentionDays(data.uninstallBackupRetentionDays),
      privacyMode: Boolean(data.privacyMode ?? legacyDemoMode ?? DEFAULT_SETTINGS.privacyMode)
    };
  }

  async saveSettings() {
    this.settings.profiles = sanitizeProfiles(this.settings.profiles, getDefaultProfiles(this.app));
    this.settings.uninstallBackupRetentionDays = sanitizeRetentionDays(
      this.settings.uninstallBackupRetentionDays
    );
    this.settings.privacyMode = Boolean(this.settings.privacyMode);
    await this.saveData(this.settings);
  }
}

class PluginProfileManagerModal extends Modal {
  private plugin: PluginProfileManagerPlugin;
  private scanResult: ScanResult | null = null;
  private draftStates = new Map<string, Map<string, ProfileState>>();
  private statusEl: HTMLElement | null = null;
  private tableHostEl: HTMLElement | null = null;
  private tableWrapperEl: HTMLElement | null = null;
  private searchQuery = "";

  constructor(app: App, plugin: PluginProfileManagerPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    this.modalEl.addClass("plugin-profile-manager-modal");
    await this.reload();
  }

  onClose() {
    this.contentEl.empty();
    this.scanResult = null;
    this.draftStates.clear();
    this.tableHostEl = null;
    this.tableWrapperEl = null;
  }

  private async reload(options: { preserveScroll?: boolean } = {}) {
    const scrollSnapshot = options.preserveScroll ? this.captureScrollSnapshot() : null;
    this.tableWrapperEl = null;
    this.contentEl.empty();
    const shell = this.contentEl.createDiv({ cls: "ppm-shell" });
    const header = shell.createDiv({ cls: "ppm-header" });
    const heading = header.createDiv();
    heading.createEl("h2", { text: "Profile manager" });
    heading.createEl("p", { text: "Manage plugin states across device profiles" });

    const actionBar = shell.createDiv({ cls: "ppm-action-bar" });
    const reloadButton = createIconButton(actionBar, "refresh-cw", "Reload");
    reloadButton.addEventListener("click", () => {
      void this.reload({ preserveScroll: true });
    });
    const saveButton = createIconButton(actionBar, "database", "Backup and save", true);
    saveButton.addEventListener("click", () => {
      void this.save();
    });
    const settingsButton = createIconButton(actionBar, "settings", "Open settings");
    settingsButton.addEventListener("click", () => this.openSettings());
    this.renderSearchControl(actionBar);
    this.statusEl = actionBar.createDiv({ cls: "ppm-status" });
    this.statusEl.setText("Loading...");
    const tableHost = shell.createDiv({ cls: "ppm-table-area" });
    this.tableHostEl = tableHost;

    try {
      this.scanResult = await scanProfiles(this.app, this.plugin);
      this.buildDraftStates(this.scanResult);
      this.renderTable(tableHost, this.scanResult);
      this.restoreScrollSnapshot(scrollSnapshot);
      this.setStatus("Loaded profiles.");
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : String(error));
      new Notice("Profile manager: failed to load profiles.");
    }
  }

  private renderSearchControl(actionBar: HTMLElement) {
    const search = actionBar.createDiv({ cls: "ppm-search" });
    setIcon(search.createSpan({ cls: "ppm-search-icon" }), "search");
    const input = search.createEl("input", {
      attr: {
        "aria-label": "Search plugins",
        placeholder: "Search plugins",
        type: "search"
      },
      cls: "ppm-search-input"
    });
    input.value = this.searchQuery;

    const clearButton = search.createEl("button", { cls: "ppm-search-clear" });
    setIcon(clearButton.createSpan(), "x");
    setTooltip(clearButton, "Clear search");
    clearButton.disabled = this.searchQuery.length === 0;

    input.addEventListener("input", () => {
      this.searchQuery = input.value;
      clearButton.disabled = normalizeSearchQuery(this.searchQuery).length === 0;
      this.renderCurrentTable();
    });

    clearButton.addEventListener("click", () => {
      this.searchQuery = "";
      input.value = "";
      clearButton.disabled = true;
      input.focus();
      this.renderCurrentTable();
    });
  }

  private renderCurrentTable() {
    if (!this.scanResult || !this.tableHostEl) {
      return;
    }

    this.tableWrapperEl = null;
    this.renderTable(this.tableHostEl, this.scanResult);
  }

  private buildDraftStates(scanResult: ScanResult) {
    this.draftStates.clear();

    for (const [pluginId] of scanResult.manifests) {
      const profileStates = new Map<string, ProfileState>();

      for (const profileSnapshot of scanResult.profiles) {
        profileStates.set(
          profileSnapshot.profile.configDir,
          getProfileState(pluginId, profileSnapshot, this.plugin.manifest.id)
        );
      }

      this.draftStates.set(pluginId, profileStates);
    }
  }

  private renderTable(container: HTMLElement, scanResult: ScanResult) {
    container.empty();
    const invalidProfiles = scanResult.profiles.filter((profile) => profile.invalidJson);

    if (invalidProfiles.length > 0) {
      const warning = container.createDiv({ cls: "ppm-warning" });
      warning.setText(
        `JSON不正: ${invalidProfiles.map((profile) => profile.profile.name).join(", ")}`
      );
    }

    const tableWrapper = container.createDiv({ cls: "ppm-table-wrapper" });
    this.tableWrapperEl = tableWrapper;
    const table = tableWrapper.createEl("table", { cls: "ppm-table" });
    const thead = table.createEl("thead");
    const headRow = thead.createEl("tr");
    headRow.createEl("th", { text: "Plugin" });

    for (const [profileIndex, profile] of scanResult.profiles.entries()) {
      const profileDisplay = getProfileDisplay(
        profile.profile,
        this.plugin.settings.privacyMode,
        profileIndex
      );
      const profileHead = headRow.createEl("th");
      profileHead.createDiv({ text: profileDisplay.name, cls: "ppm-profile-name" });
      profileHead.createDiv({ text: profileDisplay.configDir, cls: "ppm-profile-dir" });
    }
    headRow.createEl("th", { text: "Status" });

    const tbody = table.createEl("tbody");
    const manifests = Array.from(scanResult.manifests.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    const query = normalizeSearchQuery(this.searchQuery);
    const visibleManifests = manifests
      .map((manifest, index) => ({ index, manifest }))
      .filter(({ index, manifest }) =>
        pluginMatchesSearch(manifest, this.plugin.settings.privacyMode, index, query)
      );

    if (visibleManifests.length === 0) {
      const row = tbody.createEl("tr");
      row.createEl("td", {
        attr: { colspan: String(scanResult.profiles.length + 2) },
        cls: "ppm-empty-search",
        text: "No plugins match this search."
      });
    }

    for (const { index, manifest } of visibleManifests) {
      const row = tbody.createEl("tr");
      const pluginCell = row.createEl("td");
      pluginCell.addClass("ppm-plugin-cell");

      const display = getPluginDisplay(manifest, this.plugin.settings.privacyMode, index);

      pluginCell.createDiv({ text: display.name, cls: "ppm-plugin-name" });
      pluginCell.createDiv({ text: display.id, cls: "ppm-plugin-id" });

      for (const profileSnapshot of scanResult.profiles) {
        const cell = row.createEl("td");
        this.renderStateButton(cell, manifest.id, profileSnapshot);
      }

      this.renderRowStatus(row.createEl("td"), manifest.id, scanResult);
    }

    const footnote = container.createDiv({ cls: "ppm-footnote" });
    setIcon(footnote.createSpan(), "info");
    footnote.createSpan({
      text: "Changes to the current profile apply immediately after save."
    });
  }

  private renderStateButton(
    cell: HTMLElement,
    pluginId: string,
    profileSnapshot: ProfileSnapshot
  ) {
    cell.empty();
    const state = this.getDraftState(pluginId, profileSnapshot.profile.configDir);
    const installSource = this.scanResult
      ? findInstallSource(pluginId, profileSnapshot, this.scanResult)
      : null;
    const actionGroup = cell.createDiv({ cls: "ppm-cell-actions" });
    const button = actionGroup.createEl("button", {
      cls: `ppm-state ppm-state-${state.toLowerCase().replace("_", "-")}`
    });
    const knob = button.createSpan({ cls: "ppm-state-knob" });
    button.setAttr("aria-label", getStateTooltip(state));
    button.setAttr("title", getStateTooltip(state));

    const isLocked = pluginId === this.plugin.manifest.id;
    const isPrivacyMode = this.plugin.settings.privacyMode;
    const isEditable = state === "ON" || state === "OFF";
    const isInstallable = state === "UNINSTALLED" && installSource !== null;
    button.disabled = isLocked || (!isPrivacyMode && !isEditable && !isInstallable);

    if (isPrivacyMode) {
      const tooltip = "Privacy mode: changes are disabled";
      button.setAttr("aria-label", tooltip);
      button.setAttr("title", tooltip);
      button.addClass("ppm-state-privacy");
    }

    if (isLocked) {
      const tooltip = "管理プラグイン自身のためON固定";
      button.setAttr("aria-label", tooltip);
      button.setAttr("title", tooltip);
      button.addClass("ppm-state-locked");
      setIcon(knob, "lock");
    }

    if (isEditable && !isLocked) {
      button.addEventListener("click", () => {
        if (this.plugin.settings.privacyMode) {
          return;
        }

        const nextState: ProfileState = state === "ON" ? "OFF" : "ON";
        this.setDraftState(pluginId, profileSnapshot.profile.configDir, nextState);
        this.renderStateButton(cell, pluginId, profileSnapshot);
      });
    }

    if (isInstallable && installSource) {
      button.addClass("ppm-state-installable");
      setIcon(knob, "download");
      const tooltip = `${installSource.profile.name} から ${profileSnapshot.profile.name} へインストール`;
      button.setAttr("aria-label", tooltip);
      button.setAttr("title", tooltip);
      button.addEventListener("click", () => {
        if (this.plugin.settings.privacyMode) {
          return;
        }

        void this.installMissingPlugin(pluginId, profileSnapshot, installSource);
      });
    }

    this.renderUninstallButton(actionGroup, pluginId, profileSnapshot);
  }

  private renderUninstallButton(
    actionGroup: HTMLElement,
    pluginId: string,
    profileSnapshot: ProfileSnapshot
  ) {
    const isInstalled = profileSnapshot.installedIds.has(pluginId);
    if (!isInstalled) {
      return;
    }

    const button = actionGroup.createEl("button", { cls: "ppm-uninstall-button" });
    setIcon(button.createSpan({ cls: "ppm-uninstall-icon" }), "trash-2");

    const isSelf = pluginId === this.plugin.manifest.id;
    const isPrivacyMode = this.plugin.settings.privacyMode;
    const canUninstall = isInstalled && !isSelf && !profileSnapshot.invalidJson;
    button.disabled = !isPrivacyMode && !canUninstall;

    if (isPrivacyMode) {
      button.addClass("ppm-uninstall-privacy");
      setTooltip(button, "Privacy mode: changes are disabled");
    } else if (profileSnapshot.invalidJson) {
      setTooltip(button, "JSON不正のプロファイルではアンインストールできません");
    } else if (isSelf) {
      setTooltip(button, "管理プラグイン自身はアンインストールできません");
    } else {
      setTooltip(button, `${profileSnapshot.profile.name} からアンインストール`);
    }

    if (canUninstall) {
      button.addEventListener("click", () => {
        if (this.plugin.settings.privacyMode) {
          return;
        }

        new ConfirmUninstallModal(this.app, {
          pluginId,
          profileName: profileSnapshot.profile.name,
          profileDir: profileSnapshot.profile.configDir,
          onConfirm: async () => {
            await this.uninstallPlugin(pluginId, profileSnapshot);
          }
        }).open();
      });
    }
  }

  private async uninstallPlugin(pluginId: string, profileSnapshot: ProfileSnapshot) {
    try {
      await uninstallPluginFromProfile(
        this.app,
        this.plugin.settings.uninstallBackupRetentionDays,
        pluginId,
        profileSnapshot
      );
      new Notice(`${pluginId} を ${profileSnapshot.profile.name} からアンインストールしました。`);
      this.setStatus("Uninstalled. Restart Obsidian to apply changes.");
      await this.reload({ preserveScroll: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Uninstall failed: ${message}`);
      this.setStatus(message);
    }
  }

  private async installMissingPlugin(
    pluginId: string,
    targetProfile: ProfileSnapshot,
    sourceProfile: ProfileSnapshot
  ) {
    try {
      await installPluginFromProfile(this.app, pluginId, sourceProfile, targetProfile);
      new Notice(
        `${pluginId} を ${sourceProfile.profile.name} から ${targetProfile.profile.name} へコピーしました。`
      );
      this.setStatus("Installed as OFF. Toggle ON and use Backup and Save to enable.");
      await this.reload({ preserveScroll: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Install failed: ${message}`);
      this.setStatus(message);
    }
  }

  private renderRowStatus(cell: HTMLElement, pluginId: string, scanResult: ScanResult) {
    const states = scanResult.profiles.map((profile) =>
      this.getDraftState(pluginId, profile.profile.configDir)
    );
    const badge = cell.createSpan({ cls: "ppm-row-status" });

    if (pluginId === this.plugin.manifest.id) {
      badge.addClass("ppm-row-status-protected");
      badge.setText("Protected");
      return;
    }

    if (states.includes("INVALID_JSON")) {
      badge.addClass("ppm-row-status-invalid");
      badge.setText("JSON不正");
      return;
    }

    if (states.every((state) => state === "UNINSTALLED")) {
      badge.addClass("ppm-row-status-muted");
      badge.setText("未インストール");
      return;
    }

    if (states.includes("UNINSTALLED")) {
      badge.addClass("ppm-row-status-partial");
      badge.setText("Partial");
      return;
    }

    badge.addClass("ppm-row-status-installed");
    badge.setText("Installed");
  }

  private async save() {
    if (this.plugin.settings.privacyMode) {
      return;
    }

    if (!this.scanResult) {
      new Notice("Profile manager: no scan result to save.");
      return;
    }

    const invalidProfiles = this.scanResult.profiles.filter((profile) => profile.invalidJson);
    if (invalidProfiles.length > 0) {
      new Notice("JSON不正のプロファイルがあるため保存しません。");
      this.setStatus("Save blocked by invalid JSON.");
      return;
    }

    try {
      await saveProfiles(this.app, this.plugin, this.scanResult, this.draftStates);
      const runtimeResult = await applyCurrentRuntimeProfileChanges(
        this.app,
        this.plugin,
        this.scanResult,
        this.draftStates
      );
      const saveStatus = getSaveStatus(runtimeResult);
      new Notice(getSaveNotice(runtimeResult));
      await this.reload({ preserveScroll: true });
      this.setStatus(saveStatus);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Profile manager: ${message}`);
      this.setStatus(message);
    }
  }

  private getDraftState(pluginId: string, configDir: string): ProfileState {
    return this.draftStates.get(pluginId)?.get(configDir) ?? "UNINSTALLED";
  }

  private setDraftState(pluginId: string, configDir: string, state: ProfileState) {
    const profileStates = this.draftStates.get(pluginId);
    if (!profileStates) {
      return;
    }

    profileStates.set(configDir, state);
  }

  private setStatus(message: string) {
    this.statusEl?.setText(message);
  }

  private captureScrollSnapshot(): ScrollSnapshot | null {
    const tableWrapper = this.tableWrapperEl;
    if (!tableWrapper) {
      return null;
    }

    return {
      top: tableWrapper.scrollTop,
      left: tableWrapper.scrollLeft
    };
  }

  private restoreScrollSnapshot(snapshot: ScrollSnapshot | null) {
    const tableWrapper = this.tableWrapperEl;
    if (!snapshot || !tableWrapper) {
      return;
    }

    window.requestAnimationFrame(() => {
      tableWrapper.scrollTop = Math.min(
        snapshot.top,
        Math.max(0, tableWrapper.scrollHeight - tableWrapper.clientHeight)
      );
      tableWrapper.scrollLeft = Math.min(
        snapshot.left,
        Math.max(0, tableWrapper.scrollWidth - tableWrapper.clientWidth)
      );
    });
  }

  private openSettings() {
    const setting = (this.app as AppWithSetting).setting;

    if (!setting) {
      new Notice("Open settings to edit profile manager profiles.");
      return;
    }

    setting.open();
    setting.openTabById(this.plugin.manifest.id);
  }
}

interface AppWithSetting extends App {
  setting?: {
    open: () => void;
    openTabById: (id: string) => void;
  };
}

interface AppWithRuntimePlugins extends App {
  plugins?: {
    disablePlugin: (pluginId: string, userDisabled?: boolean) => Promise<void>;
    enabledPlugins: Set<string>;
    enablePlugin: (pluginId: string, userTriggered?: boolean) => Promise<boolean>;
    loadManifests: () => Promise<void>;
  };
  vault: App["vault"] & {
    configDir?: string;
  };
}

function getCurrentConfigDir(app: App): string {
  return normalizeConfigDir((app as AppWithRuntimePlugins).vault.configDir ?? "");
}

function getDefaultProfiles(app: App): ProfileConfig[] {
  const configDir = getCurrentConfigDir(app);
  return configDir.length > 0 ? [{ name: "Current", configDir }] : [];
}

interface RuntimeApplyResult {
  applied: boolean;
  enabled: string[];
  disabled: string[];
  failed: string[];
  skippedReason: string | null;
}

class PluginProfileManagerSettingTab extends PluginSettingTab {
  private plugin: PluginProfileManagerPlugin;

  constructor(app: App, plugin: PluginProfileManagerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("Profiles")
      .setHeading();

    for (const [index, profile] of this.plugin.settings.profiles.entries()) {
      const setting = new Setting(containerEl)
        .setName(profile.name || `Profile ${index + 1}`)
        .setDesc(profile.configDir || "No config folder");

      setting.addText((text) => {
        text
          .setPlaceholder("Display name")
          .setValue(profile.name)
          .onChange(async (value) => {
            const currentProfile = this.plugin.settings.profiles[index];
            if (!currentProfile) {
              return;
            }

            currentProfile.name = value;
            await this.plugin.saveSettings();
            this.display();
          });
      });

      setting.addText((text) => {
        text
          .setPlaceholder("Config folder")
          .setValue(profile.configDir)
          .onChange(async (value) => {
            const currentProfile = this.plugin.settings.profiles[index];
            if (!currentProfile) {
              return;
            }

            currentProfile.configDir = normalizeConfigDir(value);
            await this.plugin.saveSettings();
            this.display();
          });
      });

      setting.addButton((button) => {
        button
          .setButtonText("Remove")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.profiles.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          });
      });
    }

    new Setting(containerEl)
      .setName("Add profile")
      .setDesc("Register another config folder.")
      .addButton((button) => {
        button
          .setButtonText("Add")
          .setCta()
          .onClick(async () => {
            this.plugin.settings.profiles.push({
              name: `Profile ${this.plugin.settings.profiles.length + 1}`,
              configDir: getCurrentConfigDir(this.app)
            });
            await this.plugin.saveSettings();
            this.display();
          });
      });

    new Setting(containerEl)
      .setName("Privacy mode")
      .setDesc("Hide plugin names and identifiers, and disable all profile changing actions.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.privacyMode)
          .onChange(async (value) => {
            this.plugin.settings.privacyMode = value;
            await this.plugin.saveSettings();
          });
      });

      new Setting(containerEl)
      .setName("Uninstall backup retention")
      .setDesc("Delete plugin-uninstall backups older than this many days when uninstalling.")
      .addText((text) => {
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.uninstallBackupRetentionDays))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.uninstallBackupRetentionDays = sanitizeRetentionDays(parsed);
            await this.plugin.saveSettings();
          });
      });
  }
}

interface ConfirmUninstallOptions {
  pluginId: string;
  profileName: string;
  profileDir: string;
  onConfirm: () => Promise<void>;
}

class ConfirmUninstallModal extends Modal {
  private options: ConfirmUninstallOptions;

  constructor(app: App, options: ConfirmUninstallOptions) {
    super(app);
    this.options = options;
  }

  onOpen() {
    this.modalEl.addClass("plugin-profile-manager-confirm-modal");
    this.contentEl.empty();
    this.contentEl.createEl("h2", { text: "Uninstall plugin?" });
    this.contentEl.createEl("p", {
      text: `${this.options.pluginId} を ${this.options.profileName} (${this.options.profileDir}) から削除します。`
    });
    this.contentEl.createEl("p", {
      text: "削除前にバックアップを作成し、community-plugins.json からもIDを削除します。"
    });

    const actions = this.contentEl.createDiv({ cls: "ppm-confirm-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());
    const confirmButton = actions.createEl("button", {
      text: "Uninstall",
      cls: "mod-warning"
    });
    confirmButton.addEventListener("click", () => {
      confirmButton.disabled = true;
      void this.options.onConfirm().finally(() => {
        this.close();
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

async function scanProfiles(
  app: App,
  plugin: PluginProfileManagerPlugin
): Promise<ScanResult> {
  const manifests = new Map<string, ManifestInfo>();
  manifests.set(plugin.manifest.id, {
    id: plugin.manifest.id,
    name: plugin.manifest.name,
    profileDirs: new Set<string>()
  });

  const profiles: ProfileSnapshot[] = [];

  for (const profile of plugin.settings.profiles) {
    const snapshot = await scanProfile(app, profile, manifests);
    profiles.push(snapshot);
  }

  return { profiles, manifests };
}

async function scanProfile(
  app: App,
  profile: ProfileConfig,
  manifests: Map<string, ManifestInfo>
): Promise<ProfileSnapshot> {
  const configDir = normalizeConfigDir(profile.configDir);
  const communityPath = normalizePath(`${configDir}/community-plugins.json`);
  const installedPluginPaths = await readInstalledManifests(app, configDir, manifests);
  const installedIds = new Set<string>(installedPluginPaths.keys());

  try {
    const rawCommunity = await app.vault.adapter.read(communityPath);
    const parsed: unknown = JSON.parse(rawCommunity);

    if (!isPluginIdArray(parsed)) {
      throw new Error("community-plugins.json must be an array of plugin IDs.");
    }

    const enabledIds = new Set<string>(parsed);
    for (const pluginId of enabledIds) {
      ensureManifest(manifests, pluginId, pluginId, configDir);
    }

    return {
      profile: { ...profile, configDir },
      communityPath,
      rawCommunity,
      enabledIds,
      installedIds,
      installedPluginPaths,
      invalidJson: false,
      errorMessage: null
    };
  } catch (error) {
    return {
      profile: { ...profile, configDir },
      communityPath,
      rawCommunity: null,
      enabledIds: new Set<string>(),
      installedIds,
      installedPluginPaths,
      invalidJson: true,
      errorMessage: error instanceof Error ? error.message : String(error)
    };
  }
}

async function readInstalledManifests(
  app: App,
  configDir: string,
  manifests: Map<string, ManifestInfo>
): Promise<Map<string, string>> {
  const installedPluginPaths = new Map<string, string>();
  const pluginsDir = normalizePath(`${configDir}/plugins`);

  if (!(await app.vault.adapter.exists(pluginsDir))) {
    return installedPluginPaths;
  }

  const listed = await app.vault.adapter.list(pluginsDir);

  for (const folder of listed.folders) {
    const manifestPath = normalizePath(`${folder}/manifest.json`);

    if (!(await app.vault.adapter.exists(manifestPath))) {
      continue;
    }

    try {
      const rawManifest = await app.vault.adapter.read(manifestPath);
      const parsed: unknown = JSON.parse(rawManifest);
      const id = isManifestRecord(parsed) ? parsed.id : folder.split("/").pop();
      const name = isManifestRecord(parsed) ? parsed.name : id;

      if (!id) {
        continue;
      }

      installedPluginPaths.set(id, folder);
      ensureManifest(manifests, id, name ?? id, configDir);
    } catch {
      const fallbackId = folder.split("/").pop();

      if (fallbackId) {
        installedPluginPaths.set(fallbackId, folder);
        ensureManifest(manifests, fallbackId, fallbackId, configDir);
      }
    }
  }

  return installedPluginPaths;
}

async function saveProfiles(
  app: App,
  plugin: PluginProfileManagerPlugin,
  scanResult: ScanResult,
  draftStates: Map<string, Map<string, ProfileState>>
) {
  const timestamp = createTimestamp();

  for (const profileSnapshot of scanResult.profiles) {
    const currentRaw = await app.vault.adapter.read(profileSnapshot.communityPath);

    if (currentRaw !== profileSnapshot.rawCommunity) {
      throw new Error(
        `${profileSnapshot.profile.name} changed after loading. Reload before saving.`
      );
    }
  }

  for (const profileSnapshot of scanResult.profiles) {
    await writeBackup(app, timestamp, profileSnapshot);
  }

  for (const profileSnapshot of scanResult.profiles) {
    const nextEnabledIds = buildNextEnabledIds(
      plugin.manifest.id,
      profileSnapshot,
      draftStates
    );
    const nextContent = `${JSON.stringify(nextEnabledIds, null, 2)}\n`;
    await app.vault.adapter.write(profileSnapshot.communityPath, nextContent);
  }
}

async function applyCurrentRuntimeProfileChanges(
  app: App,
  plugin: PluginProfileManagerPlugin,
  scanResult: ScanResult,
  draftStates: Map<string, Map<string, ProfileState>>
): Promise<RuntimeApplyResult> {
  const runtimeApp = app as AppWithRuntimePlugins;
  const currentConfigDir = runtimeApp.vault.configDir
    ? normalizeConfigDir(runtimeApp.vault.configDir)
    : null;

  const result: RuntimeApplyResult = {
    applied: false,
    enabled: [],
    disabled: [],
    failed: [],
    skippedReason: null
  };

  if (!currentConfigDir) {
    result.skippedReason = "Current config folder was not detected.";
    return result;
  }

  if (
    !runtimeApp.plugins?.enablePlugin ||
    !runtimeApp.plugins.disablePlugin ||
    !runtimeApp.plugins.enabledPlugins ||
    !runtimeApp.plugins.loadManifests
  ) {
    result.skippedReason = "Obsidian runtime plugin APIs are unavailable.";
    return result;
  }

  const currentProfile = scanResult.profiles.find(
    (profile) => profile.profile.configDir === currentConfigDir
  );

  if (!currentProfile) {
    result.skippedReason = `No registered profile matches current config folder: ${currentConfigDir}`;
    return result;
  }

  const nextEnabledIds = buildNextEnabledIds(plugin.manifest.id, currentProfile, draftStates);
  const nextEnabled = new Set(nextEnabledIds);
  const previousEnabled = currentProfile.enabledIds;

  const idsToDisable = Array.from(previousEnabled)
    .filter((pluginId) => pluginId !== plugin.manifest.id && !nextEnabled.has(pluginId))
    .sort((a, b) => a.localeCompare(b));
  const idsToEnable = nextEnabledIds.filter(
    (pluginId) => pluginId !== plugin.manifest.id && !previousEnabled.has(pluginId)
  );

  if (idsToDisable.length === 0 && idsToEnable.length === 0) {
    result.applied = true;
    return result;
  }

  await runtimeApp.plugins.loadManifests();

  for (const pluginId of idsToDisable) {
    try {
      runtimeApp.plugins.enabledPlugins.delete(pluginId);
      await runtimeApp.plugins.disablePlugin(pluginId, true);
      result.disabled.push(pluginId);
    } catch (error) {
      console.error(`Profile Manager: failed to disable ${pluginId}`, error);
      result.failed.push(pluginId);
    }
  }

  for (const pluginId of idsToEnable) {
    try {
      runtimeApp.plugins.enabledPlugins.add(pluginId);
      const enabled = await runtimeApp.plugins.enablePlugin(pluginId, true);
      if (enabled) {
        result.enabled.push(pluginId);
      } else {
        runtimeApp.plugins.enabledPlugins.delete(pluginId);
        result.failed.push(pluginId);
      }
    } catch (error) {
      runtimeApp.plugins.enabledPlugins.delete(pluginId);
      console.error(`Profile Manager: failed to enable ${pluginId}`, error);
      result.failed.push(pluginId);
    }
  }

  result.applied = true;
  return result;
}

function getSaveNotice(result: RuntimeApplyResult): string {
  if (result.failed.length > 0) {
    return `Profile settings saved. Runtime apply failed for ${result.failed.length} plugin(s).`;
  }

  if (!result.applied) {
    return "Profile settings saved. Changes for other profiles apply when that profile opens.";
  }

  const changedCount = result.enabled.length + result.disabled.length;
  if (changedCount === 0) {
    return "Profile settings saved.";
  }

  return `Profile settings saved. Applied ${changedCount} current-profile change(s).`;
}

function getSaveStatus(result: RuntimeApplyResult): string {
  if (result.failed.length > 0) {
    return `Saved. Runtime apply failed: ${result.failed.join(", ")}`;
  }

  if (!result.applied) {
    return result.skippedReason
      ? `Saved. Runtime apply skipped: ${result.skippedReason}`
      : "Saved. Runtime apply skipped.";
  }

  const parts: string[] = [];
  if (result.enabled.length > 0) {
    parts.push(`enabled ${result.enabled.length}`);
  }
  if (result.disabled.length > 0) {
    parts.push(`disabled ${result.disabled.length}`);
  }

  return parts.length > 0 ? `Saved and applied (${parts.join(", ")}).` : "Saved.";
}

function buildNextEnabledIds(
  selfPluginId: string,
  profileSnapshot: ProfileSnapshot,
  draftStates: Map<string, Map<string, ProfileState>>
): string[] {
  const desiredOn = new Set<string>();

  for (const [pluginId, profileStates] of draftStates) {
    if (pluginId === selfPluginId || profileStates.get(profileSnapshot.profile.configDir) === "ON") {
      desiredOn.add(pluginId);
    }
  }

  const nextEnabledIds: string[] = [];

  for (const pluginId of profileSnapshot.enabledIds) {
    if (desiredOn.has(pluginId) && !nextEnabledIds.includes(pluginId)) {
      nextEnabledIds.push(pluginId);
    }
  }

  const sortedAdditionalIds = Array.from(desiredOn)
    .filter((pluginId) => !nextEnabledIds.includes(pluginId))
    .sort((a, b) => a.localeCompare(b));

  nextEnabledIds.push(...sortedAdditionalIds);
  return nextEnabledIds;
}
function getPluginDisplay(
  manifest: ManifestInfo,
  privacyMode: boolean,
  index: number
): { name: string; id: string } {
  if (!privacyMode) {
    return {
      name: manifest.name,
      id: manifest.id
    };
  }

  const num = String(index + 1).padStart(2, "0");

  return {
    name: `Plugin ${num}`,
    id: `sample-plugin-${num}`
  };
}

function getProfileDisplay(
  profile: ProfileConfig,
  privacyMode: boolean,
  index: number
): ProfileConfig {
  if (!privacyMode) {
    return profile;
  }

  const num = String(index + 1).padStart(2, "0");
  return {
    name: `Profile ${num}`,
    configDir: `config-profile-${num}`
  };
}

function pluginMatchesSearch(
  manifest: ManifestInfo,
  privacyMode: boolean,
  index: number,
  query: string
): boolean {
  if (query.length === 0) {
    return true;
  }

  const display = getPluginDisplay(manifest, privacyMode, index);
  return (
    display.name.toLowerCase().includes(query) ||
    display.id.toLowerCase().includes(query)
  );
}

function normalizeSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}
async function writeBackup(
  app: App,
  timestamp: string,
  profileSnapshot: ProfileSnapshot
) {
  if (profileSnapshot.rawCommunity === null) {
    throw new Error(`Cannot back up ${profileSnapshot.profile.name}: no readable JSON.`);
  }

  const backupPath = normalizePath(
    `${getPluginDataRoot(app)}/${BACKUP_DIR}/${timestamp}/${profileSnapshot.profile.configDir}/community-plugins.json`
  );
  await ensureParentFolder(app, backupPath);
  await app.vault.adapter.write(backupPath, profileSnapshot.rawCommunity);
}

async function ensureParentFolder(app: App, filePath: string) {
  const parts = normalizePath(filePath).split("/");
  parts.pop();
  await ensureFolder(app, parts.join("/"));
}

async function ensureFolder(app: App, folderPath: string) {
  const parts = normalizePath(folderPath).split("/").filter(Boolean);
  let currentPath = "";

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;

    if (!(await app.vault.adapter.exists(currentPath))) {
      await app.vault.adapter.mkdir(currentPath);
    }
  }
}

async function installPluginFromProfile(
  app: App,
  pluginId: string,
  sourceProfile: ProfileSnapshot,
  targetProfile: ProfileSnapshot
) {
  const sourcePath = sourceProfile.installedPluginPaths.get(pluginId);
  if (!sourcePath) {
    throw new Error(`${pluginId} is not installed in ${sourceProfile.profile.name}.`);
  }

  const targetPath = normalizePath(`${targetProfile.profile.configDir}/plugins/${pluginId}`);
  if (await app.vault.adapter.exists(targetPath)) {
    throw new Error(`${targetPath} already exists. Install will not overwrite it.`);
  }

  await copyFolderRecursive(app, sourcePath, targetPath);
}

async function uninstallPluginFromProfile(
  app: App,
  retentionDays: number,
  pluginId: string,
  profileSnapshot: ProfileSnapshot
) {
  if (profileSnapshot.invalidJson || profileSnapshot.rawCommunity === null) {
    throw new Error(`${profileSnapshot.profile.name} has invalid JSON.`);
  }

  const pluginPath = profileSnapshot.installedPluginPaths.get(pluginId);
  if (!pluginPath) {
    throw new Error(`${pluginId} is not installed in ${profileSnapshot.profile.name}.`);
  }

  const currentRaw = await app.vault.adapter.read(profileSnapshot.communityPath);
  if (currentRaw !== profileSnapshot.rawCommunity) {
    throw new Error(`${profileSnapshot.profile.name} changed after loading. Reload before uninstalling.`);
  }

  const timestamp = createTimestamp();
  const backupPath = normalizePath(
    `${getPluginDataRoot(app)}/${UNINSTALL_BACKUP_DIR}/${timestamp}/${profileSnapshot.profile.configDir}/${pluginId}`
  );
  await copyFolderRecursive(app, pluginPath, normalizePath(`${backupPath}/plugin`));
  await ensureParentFolder(app, normalizePath(`${backupPath}/community-plugins.json`));
  await app.vault.adapter.write(
    normalizePath(`${backupPath}/community-plugins.json`),
    profileSnapshot.rawCommunity
  );

  const nextEnabledIds = Array.from(profileSnapshot.enabledIds).filter((id) => id !== pluginId);
  await app.vault.adapter.write(
    profileSnapshot.communityPath,
    `${JSON.stringify(nextEnabledIds, null, 2)}\n`
  );
  await app.vault.adapter.rmdir(pluginPath, true);
  await cleanupOldUninstallBackups(app, retentionDays);
}

async function cleanupOldUninstallBackups(app: App, retentionDays: number) {
  const uninstallBackupRoot = normalizePath(`${getPluginDataRoot(app)}/${UNINSTALL_BACKUP_DIR}`);
  if (retentionDays <= 0 || !(await app.vault.adapter.exists(uninstallBackupRoot))) {
    return;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const listed = await app.vault.adapter.list(uninstallBackupRoot);

  for (const folderPath of listed.folders) {
    const folderName = folderPath.split("/").pop();
    if (!folderName) {
      continue;
    }

    const timestamp = parseBackupTimestamp(folderName);
    if (timestamp !== null && timestamp < cutoff) {
      await app.vault.adapter.rmdir(folderPath, true);
    }
  }
}

function getPluginDataRoot(app: App): string {
  return normalizePath(`${app.vault.configDir}/plugins/${PLUGIN_ID}`);
}

async function copyFolderRecursive(app: App, sourcePath: string, targetPath: string) {
  await ensureFolder(app, targetPath);
  const listed = await app.vault.adapter.list(sourcePath);

  for (const sourceFile of listed.files) {
    const fileName = sourceFile.split("/").pop();
    if (!fileName) {
      continue;
    }

    const targetFile = normalizePath(`${targetPath}/${fileName}`);
    const data = await app.vault.adapter.readBinary(sourceFile);
    await app.vault.adapter.writeBinary(targetFile, data);
  }

  for (const sourceFolder of listed.folders) {
    const folderName = sourceFolder.split("/").pop();
    if (!folderName) {
      continue;
    }

    await copyFolderRecursive(app, sourceFolder, normalizePath(`${targetPath}/${folderName}`));
  }
}

function findInstallSource(
  pluginId: string,
  targetProfile: ProfileSnapshot,
  scanResult: ScanResult
): ProfileSnapshot | null {
  for (const profile of scanResult.profiles) {
    if (
      profile.profile.configDir !== targetProfile.profile.configDir &&
      profile.installedPluginPaths.has(pluginId)
    ) {
      return profile;
    }
  }

  return null;
}

function getProfileState(
  pluginId: string,
  profileSnapshot: ProfileSnapshot,
  selfPluginId: string
): ProfileState {
  if (profileSnapshot.invalidJson) {
    return "INVALID_JSON";
  }

  if (pluginId === selfPluginId) {
    return "ON";
  }

  if (profileSnapshot.enabledIds.has(pluginId)) {
    return "ON";
  }

  if (profileSnapshot.installedIds.has(pluginId)) {
    return "OFF";
  }

  return "UNINSTALLED";
}

function getStateTooltip(state: ProfileState): string {
  switch (state) {
    case "ON":
      return "ON";
    case "OFF":
      return "OFF";
    case "UNINSTALLED":
      return "未インストール";
    case "INVALID_JSON":
      return "JSON不正";
  }
}

function ensureManifest(
  manifests: Map<string, ManifestInfo>,
  id: string,
  name: string,
  profileDir: string
) {
  const existing = manifests.get(id);

  if (existing) {
    existing.profileDirs.add(profileDir);
    if (existing.name === existing.id && name !== id) {
      existing.name = name;
    }
    return;
  }

  manifests.set(id, {
    id,
    name,
    profileDirs: new Set<string>([profileDir])
  });
}

function toRecord(value: unknown): DataRecord {
  return value !== null && typeof value === "object" ? value as DataRecord : {};
}

function isProfileConfig(value: unknown): value is ProfileConfig {
  const record = toRecord(value);
  return typeof record.name === "string" && typeof record.configDir === "string";
}

function isPluginIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isManifestRecord(value: unknown): value is { id: string; name: string } {
  const record = toRecord(value);
  return typeof record.id === "string" && typeof record.name === "string";
}

function sanitizeProfiles(profiles: unknown, fallbackProfiles: ProfileConfig[]): ProfileConfig[] {
  if (!Array.isArray(profiles)) {
    return fallbackProfiles;
  }

  const sanitized = profiles
    .filter(isProfileConfig)
    .map((profile) => ({
      name: profile.name.trim(),
      configDir: normalizeConfigDir(profile.configDir)
    }))
    .filter((profile) => profile.name.length > 0 && profile.configDir.length > 0);

  return sanitized.length > 0 ? sanitized : fallbackProfiles;
}

function sanitizeRetentionDays(value: unknown): number {
  const parsed = typeof value === "number" || typeof value === "string"
    ? Number.parseInt(String(value), 10)
    : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_SETTINGS.uninstallBackupRetentionDays;
  }

  return Math.floor(parsed);
}

function normalizeConfigDir(configDir: string): string {
  return normalizePath(configDir.trim()).replace(/^\/+|\/+$/g, "");
}

function createTimestamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join("");
}

function parseBackupTimestamp(timestamp: string): number | null {
  const match = timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  if (!year || !month || !day || !hour || !minute || !second) {
    return null;
  }

  return new Date(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10)
  ).getTime();
}

function createIconButton(
  parent: HTMLElement,
  icon: string,
  label: string,
  cta = false
): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "ppm-action-button" });
  if (cta) {
    button.addClass("ppm-action-button-primary");
  }
  setIcon(button.createSpan({ cls: "ppm-action-icon" }), icon);
  button.createSpan({ text: label });
  return button;
}

function setTooltip(element: HTMLElement, label: string) {
  element.setAttr("aria-label", label);
  element.setAttr("title", label);
}
