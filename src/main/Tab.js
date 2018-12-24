// @flow
import { BrowserView, Menu } from "electron";
import EventEmitter from "events";
import * as path from "path";

import { TAB_UPDATE } from "common/events";
import { contentRoot } from "common/urls";
import type App from "./App";
import { Archive } from "./archive";
import errorPage from "./errorPage";

declare var __static: string;

type ContextMenuRequest = {
  x: number,
  y: number,
  linkURL?: string,
  linkText?: string,
  pageURL: string,
  frameURL: string,
  srcURL?: string,
  mediaType: string,
  hasImageContents: boolean,
  isEditable: boolean,
  selectionText?: string,
  titleText?: string,
  misspelledWord?: string,
  frameCharset: string,
  inputFieldType?: string,
  menuSourceType: string,
  mediaFlags?: {
    inError: boolean,
    isPaused: boolean,
    isMuted: boolean,
    hasAudio: boolean,
    isLooping: boolean,
    isControlsVisible: boolean,
    canToggleControls: boolean,
    canRotate: boolean,
  },
  editFlags?: {
    canUndo: boolean,
    canRedo: boolean,
    canCut: boolean,
    canCopy: boolean,
    canPaste: boolean,
    canDelete: boolean,
    canSelectAll: boolean,
  },
};

type IpcHandler = (message: any) => Promise<any>;

const chromeErrorUrl = "chrome-error://chromewebdata/";

// Keeps track of URL and title changes in the context of a single navigation.
class PageTracker {
  archive: Archive;
  collectionId: Promise<number>;
  // Tracks the initial full-page navigation Archive page ID.
  rootPageId: Promise<number>;
  // Tracks the URL of the full-page navigation.
  rootUrl: string;
  // Tracks the most recent in-page navigation Archive page ID.
  currentPageId: Promise<number>;

  constructor(
    archive: Archive,
    collectionId: Promise<number>,
    rootUrl: string,
    initialTitle: string,
  ) {
    this.archive = archive;
    this.collectionId = collectionId;
    this.rootUrl = rootUrl;
    this.currentPageId = this.rootPageId = this.collectionId.then(
      collectionId =>
        this.archive.upsertPage({
          collectionId,
          url: this.rootUrl,
          title: initialTitle,
        }),
    );
  }

  trackInPageNavigation(url: string, title: string) {
    this.rootPageId.then(id => {
      this.currentPageId = this.collectionId.then(collectionId =>
        this.archive.upsertPage({
          collectionId,
          url,
          title,
          originalUrl: url === this.rootUrl ? null : this.rootUrl,
        }),
      );
    });
  }

  trackTitleChange(title: string) {
    this.currentPageId.then(id => {
      this.archive.setPageTitle(id, title);
    });
  }
}

export default class Tab extends EventEmitter {
  static _nextTabId = 0;
  static nextTabId(): string {
    this._nextTabId += 1;
    return `tab_${this._nextTabId}`;
  }

  app: App;
  id: string;
  view: BrowserView;
  activePage: ?PageTracker;
  ipcHandler: ?IpcHandler;

  constructor(app: App, id: string) {
    super();
    this.app = app;
    this.id = id;

    this.view = new BrowserView({
      webPreferences: {
        nodeIntegration: false,
        enableRemoteModule: false,
        sandbox: true,
        session: this.app.session,
        affinity: this.app.id,
        scrollBounce: true,
        backgroundThrottling: true,
        preload: path.join(__static, "preload.js"),
      },
    });
    this.view.setAutoResize({ width: true, height: true });

    this.view.webContents.on("did-start-loading", this.handleStartLoading);
    this.view.webContents.on("did-stop-loading", this.handleStopLoading);
    this.view.webContents.on("did-fail-load", this.handleLoadFailure);
    this.view.webContents.on("dom-ready", this.handleDomReady);
    this.view.webContents.on("page-title-updated", this.handleTitleUpdated);
    this.view.webContents.on("did-navigate", this.handleNavigation);
    this.view.webContents.on(
      "did-navigate-in-page",
      this.handleInPageNavigation,
    );
    this.view.webContents.on("context-menu", this.handleContextMenu);
  }

  attachView() {
    this.app.window.setBrowserView(this.view);
    this.view.setBounds(this.app.getTabBounds());
    this.view.webContents.invalidate();
  }

  openDevTools() {
    this.view.webContents.openDevTools({ mode: "bottom" });
  }

  requestUpdate(data: any) {
    if (data.url) {
      this.loadURL(data.url);
    }
  }

  loadURL(url: string) {
    this.activePage = null;
    this.view.webContents.loadURL(url);
  }

  goToOffset(offset: number) {
    this.view.webContents.goToOffset(offset);
  }

  reload() {
    this.view.webContents.reload();
  }

  stop() {
    this.view.webContents.stop();
  }

  setIpcHandler(ipcHandler: ?IpcHandler) {
    this.ipcHandler = ipcHandler;
  }

  getURL(): string {
    return this.view.webContents.getURL();
  }

  executeJavaScript(script: string): Promise<any> {
    return this.view.webContents.executeJavaScript(script);
  }

  toJSON() {
    const webContents = this.view.webContents;
    const loadFraction = !webContents.isLoadingMainFrame()
      ? 1
      : !webContents.isWaitingForResponse() ? 0.5 : 0.1;
    return {
      id: this.id,
      url: webContents.getURL(),
      title: webContents.getTitle(),
      loadFraction,
      canNavigateBack: webContents.canGoBack(),
      canNavigateForward: webContents.canGoForward(),
    };
  }

  handleStartLoading = () => {
    this.emit(TAB_UPDATE, this.toJSON());
  };

  handleStopLoading = () => {
    this.emit(TAB_UPDATE, this.toJSON());
  };

  handleDomReady = (event: any) => {
    this.emit(TAB_UPDATE, this.toJSON());
    if (event.sender.getURL().startsWith(contentRoot)) {
      this.installIpcServer(event.sender);
    }
  };

  handleTitleUpdated = (_event: any, title: string) => {
    this.emit(TAB_UPDATE, this.toJSON());
    if (this.app.networkAdapter.isRecording() && this.activePage) {
      this.activePage.trackTitleChange(title);
    }
  };

  handleNavigation = (_event: mixed, url: string, statusCode: number) => {
    if (
      this.app.networkAdapter.isRecording() &&
      !this.app.networkAdapter.urlBypassesPersister(url) &&
      statusCode > 0
    ) {
      this.activePage = new PageTracker(
        this.app.archive,
        this.app.recordingSession.collectionId,
        url,
        this.view.webContents.getTitle(),
      );
    } else {
      this.activePage = null;
    }
  };

  handleInPageNavigation = (_event: any, url: string, isMainFrame: boolean) => {
    if (
      this.app.networkAdapter.isRecording() &&
      isMainFrame &&
      this.activePage
    ) {
      this.activePage.trackInPageNavigation(
        url,
        this.view.webContents.getTitle(),
      );
    }
  };

  handleLoadFailure = (
    event: any,
    code: number,
    error: string,
    url: string,
  ) => {
    event.sender.executeJavaScript("window.location.href").then(location => {
      if (location !== chromeErrorUrl) return;
      this.activePage = null;
      const { css, title, html } = errorPage(code, error, url);
      event.sender.insertCSS(css);
      event.sender
        .executeJavaScript(
          `document.title = ${JSON.stringify(title)};
          document.body.innerHTML = ${JSON.stringify(html)};
          new Promise(function(resolve) { window.resolveError = resolve; });`,
        )
        .then(ret => {
          if (ret === "start-recording") {
            this.app.handleRequestNetworkMode({ mode: "record" });
          } else {
            event.sender.reload();
          }
        });
    });
  };

  handleContextMenu = (event: any, request: ContextMenuRequest) => {
    const menu = Menu.buildFromTemplate([
      {
        label: "Open Developer Tools",
        click: () => this.openDevTools(),
      },
    ]).popup({
      window: this.view,
      x: request.x,
      y: request.y + this.app.chromeHeight,
    });
  };

  installIpcServer(webContents: any) {
    const advanceQueue = (arg: any) =>
      webContents.executeJavaScript(
        `(window.ipcClient && window.ipcClient.advanceQueue) ? window.ipcClient.advanceQueue(${JSON.stringify(
          arg,
        )}) : null`,
      );
    const handleIpcRequest = (request: any) => {
      // On null request, shut down the channel.
      if (request === null) return;
      Promise.resolve(null)
        .then(() => {
          if (!this.ipcHandler) return Promise.reject("no IPC handler");
          return this.ipcHandler(request);
        })
        .then(data => advanceQueue({ data }), error => advanceQueue({ error }))
        .then(handleIpcRequest);
    };
    advanceQueue(null).then(handleIpcRequest);
  }
}
