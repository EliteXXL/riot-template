import riot = require("riot");
// @ts-ignore
import AppComponent from "./components/app";

riot.component(AppComponent)(document.querySelector("app") as HTMLElement);