import * as React from "react";
import ReactDOM from "react-dom";

import "bulma/css/bulma.css";
import "@fortawesome/fontawesome-free/css/fontawesome.css";
import "@fortawesome/fontawesome-free/css/solid.css";

import * as urls from "common/urls";

import Chrome from "./Chrome";
import CollectionBrowser from "./CollectionBrowser";

// We treat each of these as a completely separate application, so we don't
// bother with a dynamic router at this level.
if (window.location.href === urls.chromeUrl) {
  ReactDOM.render(<Chrome />, document.getElementById("app"));
} else {
  ReactDOM.render(<CollectionBrowser />, document.getElementById("app"));
}
