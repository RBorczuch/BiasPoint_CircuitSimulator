//! Python module `bpt_native`: bindings to the BiasPoint Rust crates.

use pyo3::prelude::*;

#[pymodule]
mod bpt_native {
    use std::sync::{Arc, OnceLock};

    use pyo3::exceptions::PyValueError;
    use pyo3::prelude::*;
    use pyo3::types::PyBytes;
    use resvg::{tiny_skia, usvg};

    /// Version of the bpt_native extension module.
    #[pyfunction]
    fn version() -> &'static str {
        env!("CARGO_PKG_VERSION")
    }

    /// Min/max decimation of `y` into `buckets` (min, max) pairs.
    #[pyfunction]
    fn minmax_decimate(y: Vec<f64>, buckets: usize) -> Vec<(f64, f64)> {
        bpt_dsp::minmax_decimate(&y, buckets)
    }

    /// System fonts, loaded once (loading them takes ~100 ms).
    fn fonts() -> Arc<usvg::fontdb::Database> {
        static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
        FONTS
            .get_or_init(|| {
                let mut db = usvg::fontdb::Database::new();
                db.load_system_fonts();
                Arc::new(db)
            })
            .clone()
    }

    /// Largest image rendered: a tall schematic at the asked width once needed 17 GB and the
    /// failed allocation aborted the whole backend process.
    const MAX_PIXELS: f32 = 40_000_000.0;
    const MAX_SIDE: f32 = 16_384.0;

    /// Render an SVG document to PNG bytes `width` pixels wide (height keeps the aspect),
    /// smaller when the image would exceed `MAX_PIXELS` or `MAX_SIDE`. The GIL is released
    /// while rendering: a big picture takes seconds and other requests go on meanwhile.
    #[pyfunction]
    fn svg_to_png<'py>(py: Python<'py>, svg: &str, width: u32) -> PyResult<Bound<'py, PyBytes>> {
        let png = py
            .detach(|| render_png(svg, width))
            .map_err(PyValueError::new_err)?;
        Ok(PyBytes::new(py, &png))
    }

    fn render_png(svg: &str, width: u32) -> Result<Vec<u8>, String> {
        let options = usvg::Options {
            fontdb: fonts(),
            ..usvg::Options::default()
        };
        let tree = usvg::Tree::from_str(svg, &options).map_err(|e| format!("invalid SVG: {e}"))?;
        let size = tree.size();
        let scale = (width.max(1) as f32 / size.width())
            .min((MAX_PIXELS / (size.width() * size.height())).sqrt())
            .min(MAX_SIDE / size.width())
            .min(MAX_SIDE / size.height());
        let width = (size.width() * scale).ceil().max(1.0) as u32;
        let height = (size.height() * scale).ceil().max(1.0) as u32;
        let mut pixmap =
            tiny_skia::Pixmap::new(width, height).ok_or_else(|| "image too large".to_string())?;
        resvg::render(
            &tree,
            tiny_skia::Transform::from_scale(scale, scale),
            &mut pixmap.as_mut(),
        );
        pixmap
            .encode_png()
            .map_err(|e| format!("PNG encoding failed: {e}"))
    }
}
