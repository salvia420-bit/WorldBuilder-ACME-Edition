//! particle_manager.js `_sortBucketBackToFront(im, n, cam)`: the back-to-front
//! sort of an alpha bucket's first `n` instances.
//!
//! The JS sorts a `Uint32Array` of instance indices with
//! `idx.sort((a, b) => _sortKey[b] - _sortKey[a])`. V8 (src/builtins/
//! typed-array-sort.tq) runs a typed array sort with a comparator as a
//! top-down merge sort over two ping-pong work arrays, splitting at
//! `from + ((to - from) >>> 1)` and taking the LEFT element when
//! `compare(left, right) <= 0` (a NaN result counts as 0). That is
//! reproduced exactly here, so ties — and NaN/infinite keys — resolve as V8
//! resolves them. Keys are the f32 `_sortKey` values (a `Float32Array`).

/// `TypedArrayMergeSort(source, from, to, target)`: leaves `target[from..to)`
/// sorted; both arrays hold the same elements in that range on entry.
fn merge_sort(source: &mut [u32], target: &mut [u32], from: usize, to: usize, key: &[f32]) {
    let middle = from + ((to - from) >> 1);
    if middle - from > 1 {
        merge_sort(target, source, from, middle, key);
    }
    if to - middle > 1 {
        merge_sort(target, source, middle, to, key);
    }
    // TypedArrayMerge(source, from, middle, to, target)
    let mut left = from;
    let mut right = middle;
    for target_index in from..to {
        if left < middle && right >= to {
            target[target_index] = source[left];
            left += 1;
        } else if left < middle {
            let l = source[left];
            let r = source[right];
            // comparefn(l, r) = key[r] - key[l]; `<= 0` (or NaN) takes the left.
            let v = key[r as usize] as f64 - key[l as usize] as f64;
            if !(v > 0.0) {
                target[target_index] = l;
                left += 1;
            } else {
                target[target_index] = r;
                right += 1;
            }
        } else {
            target[target_index] = source[right];
            right += 1;
        }
    }
}

/// `%TypedArray%.prototype.sort(comparefn)` on `idx` (V8's merge sort).
pub fn v8_typed_sort_desc(idx: &mut [u32], key: &[f32], work: &mut Vec<u32>) {
    let len = idx.len();
    if len < 2 {
        return;
    }
    work.clear();
    work.extend_from_slice(idx);
    // TypedArrayMergeSort(work2, 0, len, work1): work1 (= idx) receives the result.
    merge_sort(work.as_mut_slice(), idx, 0, len, key);
}

/// Reusable scratch for `sort_back_to_front` (the JS module-level
/// `_sortIdx/_sortKey/_sortMat/_sortCol`).
#[derive(Default, Debug)]
pub struct SortScratch {
    idx: Vec<u32>,
    key: Vec<f32>,
    work: Vec<u32>,
    mat: Vec<f32>,
    col: Vec<f32>,
}

/// `_sortBucketBackToFront`: `mat` holds `n * 16` instance matrix floats,
/// `col` (optional) `n * 3` colour floats; `cam` is the camera in the
/// bucket's local space (f64, as the JS `Vector3`).
pub fn sort_back_to_front(mat: &mut [f32], col: Option<&mut [f32]>, n: usize, cam: [f64; 3], sc: &mut SortScratch) {
    if n < 2 {
        return;
    }
    sc.idx.clear();
    sc.key.clear();
    for i in 0..n {
        let dx = mat[i * 16 + 12] as f64 - cam[0];
        let dy = mat[i * 16 + 13] as f64 - cam[1];
        let dz = mat[i * 16 + 14] as f64 - cam[2];
        sc.key.push((dx * dx + dy * dy + dz * dz) as f32);
        sc.idx.push(i as u32);
    }
    v8_typed_sort_desc(&mut sc.idx, &sc.key, &mut sc.work);
    sc.mat.clear();
    sc.mat.extend_from_slice(&mat[..n * 16]);
    match col {
        Some(col) => {
            sc.col.clear();
            sc.col.extend_from_slice(&col[..n * 3]);
            for i in 0..n {
                let j = sc.idx[i] as usize;
                if j == i {
                    continue;
                }
                mat[i * 16..i * 16 + 16].copy_from_slice(&sc.mat[j * 16..j * 16 + 16]);
                col[i * 3..i * 3 + 3].copy_from_slice(&sc.col[j * 3..j * 3 + 3]);
            }
        }
        None => {
            for i in 0..n {
                let j = sc.idx[i] as usize;
                if j == i {
                    continue;
                }
                mat[i * 16..i * 16 + 16].copy_from_slice(&sc.mat[j * 16..j * 16 + 16]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_descending() {
        let key = [1.0f32, 3.0, 2.0, 3.0, 1.0];
        let mut idx = [0u32, 1, 2, 3, 4];
        let mut w = Vec::new();
        v8_typed_sort_desc(&mut idx, &key, &mut w);
        assert_eq!(idx, [1, 3, 2, 0, 4]);
    }

    #[test]
    fn nan_keys_take_left() {
        let key = [f32::NAN, 2.0, f32::NAN, 5.0];
        let mut idx = [0u32, 1, 2, 3];
        let mut w = Vec::new();
        v8_typed_sort_desc(&mut idx, &key, &mut w);
        // [0,1] merge: k1 - NaN = NaN → left (0); then 1. [2,3]: 5 - NaN → 2, 3.
        // [0,1]+[2,3]: k2 - k0 NaN → 0; k2 - k1 NaN → 1; then 2, 3.
        assert_eq!(idx, [0, 1, 2, 3]);
    }
}
