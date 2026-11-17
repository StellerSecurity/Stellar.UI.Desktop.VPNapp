use std::ffi::{CString, c_char};
use std::iter::FusedIterator;
use std::ptr::NonNull;

mod libc {
    pub use std::ffi::c_char;
}

mod ffi {
    use super::c_char;

    #[repr(C)]
    #[derive(Debug)]
    pub struct GVariant {
        _private: [u8; 0],
    }

    #[link(name = "glib_probe")]
    unsafe extern "C" {
        pub fn g_variant_new_strv(values: *const *const c_char, length: isize) -> *mut GVariant;
        pub fn g_variant_ref_sink(value: *mut GVariant) -> *mut GVariant;
        pub fn g_variant_unref(value: *mut GVariant);
        pub fn g_variant_n_children(value: *mut GVariant) -> usize;
        pub fn g_variant_get_child(value: *mut GVariant, index: usize, format: *const c_char, ...);
    }
}

#[derive(Debug)]
pub struct Variant(NonNull<ffi::GVariant>);

impl Variant {
    fn strings(values: &[String]) -> Self {
        let owned: Vec<CString> = values.iter().map(|value| CString::new(value.as_str()).unwrap()).collect();
        let pointers: Vec<*const c_char> = owned.iter().map(|value| value.as_ptr()).collect();
        // GLib copies the strings into its variant. Sink the floating reference
        // once, then release it exactly once in Drop.
        let value = unsafe { ffi::g_variant_new_strv(pointers.as_ptr(), pointers.len() as isize) };
        let value = NonNull::new(value).expect("valid string-array variant");
        assert_eq!(unsafe { ffi::g_variant_ref_sink(value.as_ptr()) }, value.as_ptr());
        Self(value)
    }

    fn n_children(&self) -> usize {
        unsafe { ffi::g_variant_n_children(self.0.as_ptr()) }
    }

    fn to_glib_none(&self) -> (*mut ffi::GVariant,) {
        (self.0.as_ptr(),)
    }
}

impl Drop for Variant {
    fn drop(&mut self) {
        unsafe { ffi::g_variant_unref(self.0.as_ptr()) };
    }
}

// This file is materialized directly from the hash-verified production source.
// The complete VariantStrIter implementation is compiled without modification.
include!("variant-str-iter.rs");

#[test]
fn empty_array_stays_exhausted_from_both_ends() {
    let variant = Variant::strings(&[]);
    let mut iter = VariantStrIter::new(&variant);
    assert_eq!(iter.len(), 0);
    assert_eq!(iter.size_hint(), (0, Some(0)));
    assert_eq!(iter.next(), None);
    assert_eq!(iter.next_back(), None);
    assert_eq!(iter.nth(usize::MAX), None);
    assert_eq!(iter.nth_back(usize::MAX), None);
}

#[test]
fn borrowed_unicode_empty_and_long_strings_survive_iterator_drop() {
    let values = vec![String::new(), "Stellar".into(), "ø🔐日本語".into(), "x".repeat(8192)];
    let variant = Variant::strings(&values);
    let borrowed: Vec<&str> = VariantStrIter::new(&variant).collect();
    assert_eq!(borrowed, values.iter().map(String::as_str).collect::<Vec<_>>());
    assert_eq!(borrowed[2], "ø🔐日本語");
    assert_eq!(borrowed[3].len(), 8192);
}

#[test]
fn forward_reverse_nth_and_mixed_iteration_match_owned_model() {
    for length in 0..128 {
        let values: Vec<String> = (0..length).map(|index| format!("entry-{index}-ø")).collect();
        let variant = Variant::strings(&values);
        assert_eq!(VariantStrIter::new(&variant).collect::<Vec<_>>(), values);
        assert_eq!(VariantStrIter::new(&variant).rev().collect::<Vec<_>>(), values.iter().rev().collect::<Vec<_>>());
        for skip in [0, 1, length, length + 1, usize::MAX] {
            assert_eq!(VariantStrIter::new(&variant).nth(skip), values.get(skip).map(String::as_str));
            assert_eq!(VariantStrIter::new(&variant).nth_back(skip), values.iter().rev().nth(skip).map(String::as_str));
        }
        let mut model: std::collections::VecDeque<&str> = values.iter().map(String::as_str).collect();
        let mut iter = VariantStrIter::new(&variant);
        while !model.is_empty() {
            assert_eq!(iter.len(), model.len());
            assert_eq!(iter.size_hint(), (model.len(), Some(model.len())));
            assert_eq!(iter.next(), model.pop_front());
            assert_eq!(iter.next_back(), model.pop_back());
        }
        assert_eq!(iter.next(), None);
        assert_eq!(iter.next_back(), None);
    }
}

#[test]
fn count_last_and_overflow_preserve_exact_iterator_contract() {
    let values = vec!["first".into(), "second".into(), "last".into()];
    let variant = Variant::strings(&values);
    assert_eq!(VariantStrIter::new(&variant).count(), 3);
    assert_eq!(VariantStrIter::new(&variant).last(), Some("last"));
    let mut iter = VariantStrIter::new(&variant);
    assert_eq!(iter.next(), Some("first"));
    assert_eq!(iter.nth(usize::MAX), None);
    assert_eq!(iter.len(), 0);
    assert_eq!(iter.next_back(), None);
}

#[test]
fn test_process_does_not_load_gio() {
    let maps = std::fs::read_to_string("/proc/self/maps").unwrap();
    assert!(maps.contains("libglib-2.0.so"));
    assert!(!maps.contains("libgio-2.0.so"));
    assert!(!maps.contains("libgobject-2.0.so"));
}
