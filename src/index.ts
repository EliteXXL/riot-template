import { component } from "riot";
import AppComponent from "./components/app.riot";

component(AppComponent)(document.querySelector("app") as HTMLElement);