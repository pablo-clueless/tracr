import { useEffect, useState } from "react";

import type { User } from "../types";

/**
 * The Phase 2 gate: a value typed here must reach the fetch body with intact
 * provenance. `useState` holds a primitive in the fiber, which is why the React
 * adapter has to shim it.
 */
const Home = () => {
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState("");

  async function fetchUser(): Promise<User[]> {
    const response = await fetch("https://jsonplaceholder.typicode.com/users");
    if (!response.ok) throw new Error(response.statusText);
    const users = await response.json();
    return users as User[];
  }

  useEffect(() => {
    fetchUser().then((users) => {
      setUsers(users);
    });
  }, []);

  const search = async () => {
    const term = name.trim().toLowerCase();
    await fetch("/users/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: term }),
    });
  };

  return (
    <div className="container flex flex-col">
      <h1>tracr react example</h1>
      <div className="flex">
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="name" />
        <button onClick={search}>search</button>
      </div>
      <div className="grid grid-cols-4">
        {users.map((user) => (
          <div className="card" key={user.id}>
            <p>{user.name}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Home;
