import './table.css'

export default function Table({ columns, rows }) {
    if(!Array.isArray(columns) || !Array.isArray(rows)) {
        return null;
    }

    const headers = columns.filter((column) => column !== "Key"); 

    return (
        <div className="table-container">
            <table className="data-table">
                <thead>
                    <tr>{ headers.map((header) => <th key={header}>{header}</th>) }</tr>
                </thead>
                <tbody>
                    {
                        rows.map((row) =>
                            <tr key={row["Key"]}>
                                { headers.map((h) => <td key={h}>{row[h]}</td>) }
                            </tr>
                        )
                    }
                </tbody>
            </table>
        </div>
    );
}