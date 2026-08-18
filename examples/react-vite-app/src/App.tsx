import { Routes, Route } from "react-router-dom";
import { Suspense } from "react";

import { ROUTES } from "./config/routes";

function App() {
  return (
    <Suspense>
      <Routes>
        {ROUTES.map(({ component: Component, label, path }) => (
          <Route key={label} path={path} element={<Component />} />
        ))}
      </Routes>
    </Suspense>
  );
}

export default App;
