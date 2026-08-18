import React from "react";

interface RouteConfig {
  label: string;
  path: string;
  component: React.LazyExoticComponent<React.FC>;
}

export const ROUTES: RouteConfig[] = [
  {
    label: "Home",
    path: "/",
    component: React.lazy(() => import("../pages/Home")),
  },
  {
    label: "About",
    path: "/about",
    component: React.lazy(() => import("../pages/About")),
  },
];
