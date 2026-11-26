import config from "../config/config";

export default function Login() {
    return (
        <div>
            <p>Not connected.</p>
            <a href={`${config.server.origin}/upstox/login`}>
                Connect To Upstox
            </a>
        </div>
    )
}