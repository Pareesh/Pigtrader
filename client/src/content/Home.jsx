import { useCallback, useState, useEffect } from "react";
import { fetchJson, loadWrapper } from "../util/util";
import Section from "../components/Section";
import Table from "../components/Table";
import './home.css'

export default function HomeContent() {
    const [positions, setPositions] = useState([]);
    const [holdings, setHoldings] = useState([]);
    const [orders, setOrders] = useState([]);
    const [funds, setFunds] = useState([]);

    const loadFunds = loadWrapper(useCallback(async () => {
        const data = await fetchJson("/v0/funds");
        const trade = data?.available_to_trade?.cash_available_to_trade;
        const cash = trade.cash;
        const margin = trade.margin_used;
        
        setFunds([{
            "Key": "funds",
            "Opening Balance": cash.opening_balance,
            "Available Cash": trade.total,
            "Used Margin": margin.total
        }]);
    }, []));

    const loadOrders = loadWrapper(useCallback(async () => {
        const data = await fetchJson("/v0/orders");
        const result = data.map((d, i) => ({
            "Index": i + 1,
            "Key": d.tradingsymbol,
            "Symbol": d.tradingsymbol,
            "Buy Price": d.average_price ?? d.price,
            "Quantity": d.quantity,
            "Type": d.transaction_type,
            "Order Type": d.order_type,
            "Status": d.status
        }));
        setOrders(result);
    }, []));

    const loadPositions = loadWrapper(useCallback(async () => {
        const data = await fetchJson("/v0/positions");
        const result = data.map((d) => ({
            "Key": d.tradingsymbol,
            "Symbol": d.tradingsymbol,
            "Buy Price": d.buy_price,
            "Current Price": d.last_price,
            "Quantity": d.quantity,
            "Buy Value": d.buy_value,
            "Current Value": d.value,
            "Profit N Loss": d.pnl
        }));
        setPositions(result)
    }, []));


    const loadHoldings = loadWrapper(useCallback(async () => {
        const data = await fetchJson("/v0/holdings");
        const result = data.map((d) => ({
            "Key": d.tradingsymbol,
            "Symbol": d.tradingsymbol,
            "Company Name": d.company_name,
            "Quantity": d.quantity,
            "Buy Price": d.average_price,
            "Current Price": d.last_price,
            "Buy Value": (d.quantity * d.average_price).toFixed(2),
            "Current Value": (d.quantity * d.last_price).toFixed(2),
            "Profit N Loss": d.pnl
        }));
        setHoldings(result);
    }, []));

    useEffect(() => {
        function initialLoad () {
            loadFunds();
            loadOrders();
            loadPositions();
            loadHoldings();
        }
        initialLoad();
    }, []);

    useEffect(() => {
        const intervalId = setInterval(() => {
            void loadFunds();
        }, 60000);

        return () => clearInterval(intervalId)
    }, [loadOrders]);

    useEffect(() => {
        const intervalId = setInterval(() => {
            void loadOrders();
        }, 30000);

        return () => clearInterval(intervalId)
    }, [loadOrders]);

    useEffect(() => {
        const intervalId = setInterval(() => {
            void loadPositions();
        }, 30000);

        return () => clearInterval(intervalId)
    }, [loadPositions]);

    useEffect(() => {
        const intervalId = setInterval(() => {
            void loadHoldings();
        }, 60000);

        return () => clearInterval(intervalId)
    }, [loadHoldings]);

    return (
        <div className="content">
            <Section title="Funds" onReload={loadFunds}>
                {funds.length > 0 && <Table columns={Object.keys(funds[0])} rows={funds}></Table>}
            </Section>
            <Section title="Orders" onReload={loadOrders}>
                {orders.length > 0 && <Table columns={Object.keys(orders[0])} rows={orders}></Table>}
            </Section>
            <Section title="Positions" onReload={loadPositions}>
                {positions.length > 0 && <Table columns={Object.keys(positions[0])} rows={positions}></Table>}
            </Section>
            <Section title="Holdings" onReload={loadHoldings}>
                {holdings.length > 0 && <Table columns={Object.keys(holdings[0])} rows={holdings}></Table>}
            </Section>
        </div>
    )
}