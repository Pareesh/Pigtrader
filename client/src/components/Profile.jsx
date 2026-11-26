import { useContext } from "react"
import UserContext from "../context/UserContext"
import { fetchJson } from "../util/util";
import './profile.css'

export default function Profile() {
    const { user, setUser } = useContext(UserContext);

    const disconnect = async () => {
        setUser(null);
        await fetchJson('/user/logout', { method: 'POST' });
    }

    return (
        <div className="profile">
            <span className="greeting">{`Welcome ${user.user_name}!`}</span>
            <button type="button" onClick={disconnect}>
                Disconnect
            </button>
        </div>
    )
}