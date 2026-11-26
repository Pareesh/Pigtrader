const config = {};

config.server = {
    origin: "http://localhost:4000"
};

config.upstox = {
    connect: `${config.server.origin}/upstox`
}

export default config;