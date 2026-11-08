//! Waveform processing for BiasPoint.

/// Version of the DSP crate.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Min/max decimation: splits `y` into `buckets` equal chunks and returns
/// `(min, max)` for each chunk, preserving peaks for plotting.
///
/// Returns an empty vector when `y` is empty or `buckets` is zero. A bucket of NaN only
/// gives `(NaN, NaN)` (a gap), not the empty fold `(+inf, -inf)`.
pub fn minmax_decimate(y: &[f64], buckets: usize) -> Vec<(f64, f64)> {
    if y.is_empty() || buckets == 0 {
        return Vec::new();
    }
    let buckets = buckets.min(y.len());
    (0..buckets)
        .map(|b| {
            let start = b * y.len() / buckets;
            let end = (b + 1) * y.len() / buckets;
            let (lo, hi) = y[start..end]
                .iter()
                .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), &v| {
                    (lo.min(v), hi.max(v))
                });
            if lo > hi {
                (f64::NAN, f64::NAN)
            } else {
                (lo, hi)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::minmax_decimate;

    #[test]
    fn keeps_peaks() {
        let y = [0.0, 5.0, 1.0, -3.0, 2.0, 2.0];
        assert_eq!(minmax_decimate(&y, 2), vec![(0.0, 5.0), (-3.0, 2.0)]);
    }

    #[test]
    fn nan_bucket_is_a_gap() {
        let out = minmax_decimate(&[f64::NAN, f64::NAN, 1.0, f64::NAN], 2);
        assert!(out[0].0.is_nan() && out[0].1.is_nan());
        assert_eq!(out[1], (1.0, 1.0));
    }

    #[test]
    fn more_buckets_than_samples() {
        let y = [1.0, 2.0];
        assert_eq!(minmax_decimate(&y, 10), vec![(1.0, 1.0), (2.0, 2.0)]);
    }

    #[test]
    fn empty_input() {
        assert!(minmax_decimate(&[], 4).is_empty());
        assert!(minmax_decimate(&[1.0], 0).is_empty());
    }
}
