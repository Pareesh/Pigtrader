import './section.css'

export default function Section({ title, onReload, children }) {
    return (
        <section className="section">
            <div className="section-header">
                <h2>{title}</h2>
                <button className="reload-button" type="button" aria-label="Reload positions" title="Reload" onClick={onReload}>
                    <span aria-hidden="true">↻</span>
                </button>
            </div>
            <div className="section-body">
                { children } 
            </div>
        </section>
    );
}