import { useState, useEffect } from 'react'
import './App.css'
import UserContext from './context/UserContext';
import Profile from './components/Profile';
import { fetchJson } from './util/util';
import Home from './content/Home';
import { useNavigate } from 'react-router';
import Login from './content/Login';

function App() {
    const [user, setUser] = useState(null);
    const navigate = useNavigate();

    useEffect(() => {
        fetchJson("/user/profile")
        .then((profile) => {
            setUser(!profile ? null : profile.profile);
        }).catch((err) => {
            console.error(err);
        });
    }, []);

    return (
        <UserContext value={{ user, setUser }}>
            <div className="container">
                <header className="header">
                    <button className="logo" onClick={() => navigate('/')}>Stock Trader</button>
                    {user && <Profile />}
                </header>
                <nav></nav>
                <aside></aside>
                <div className="content-container">
                    {user ? <Home></Home> : <Login></Login>}
                </div>
            </div>
        </UserContext>
    )
}

export default App
