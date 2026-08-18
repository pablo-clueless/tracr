import { useState } from "react";

/**
 * The Phase 2 gate: a value typed here must reach the fetch body with intact
 * provenance. `useState` holds a primitive in the fiber, which is why the React
 * adapter has to shim it.
 */
const Home = () => {
  const [name, setName] = useState("");

  const search = async () => {
    const term = name.trim().toLowerCase();
    await fetch("/users/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: term }),
    });
  };

  return (
    <div>
      <h1>tracr react example</h1>
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="name" />
      <button onClick={search}>search</button>
    </div>
  );
};

export default Home;
