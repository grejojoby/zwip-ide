use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSEventMask};
use std::{cell::RefCell, ptr::NonNull};
use tauri::{Emitter, Manager};

thread_local! {
    static MONITOR: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

fn swipe_direction(x: f64, y: f64) -> Option<&'static str> {
    if !x.is_finite() || !y.is_finite() || x.abs() <= y.abs() {
        return None;
    }
    // AppKit deltaX is -1 for a physical swipe right, +1 for a swipe left.
    Some(if x < 0.0 { "back" } else { "forward" })
}

/// AppKit's discrete swipe event represents the system's configured page gesture.
/// Monitor only this app, leaving two-finger scrolling and system gestures alone.
pub fn install(app: tauri::AppHandle) -> Result<(), std::io::Error> {
    MainThreadMarker::new()
        .ok_or_else(|| std::io::Error::other("Install swipe navigation on the main thread"))?;
    MONITOR.with_borrow_mut(|monitor| {
        if monitor.is_some() {
            return Ok(());
        }
        let handler = RcBlock::new(move |pointer: NonNull<NSEvent>| {
            // AppKit supplies a live event for the duration of this main-thread callback.
            let event = unsafe { pointer.as_ref() };
            let Some(direction) = swipe_direction(event.deltaX(), event.deltaY()) else {
                return pointer.as_ptr();
            };
            let Some(main_thread) = MainThreadMarker::new() else {
                return pointer.as_ptr();
            };
            let Some(native_window) = event.window(main_thread) else {
                return pointer.as_ptr();
            };
            let native_pointer = Retained::as_ptr(&native_window).cast_mut().cast();
            for window in app.webview_windows().into_values() {
                if window.ns_window().ok() == Some(native_pointer)
                    && app
                        .emit_to(window.label(), "zwip://navigate-history", direction)
                        .is_ok()
                {
                    // Prevent WKWebView from treating the same swipe as browser-page history.
                    return std::ptr::null_mut();
                }
            }
            pointer.as_ptr()
        });
        // The callback returns the original valid event or null, as AppKit requires.
        *monitor = Some(
            unsafe {
                NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::Swipe, &handler)
            }
            .ok_or_else(|| std::io::Error::other("macOS could not register swipe navigation"))?,
        );
        Ok(())
    })
}

pub fn shutdown() {
    MONITOR.with_borrow_mut(|monitor| {
        if let Some(monitor) = monitor.take() {
            // This token comes only from addLocalMonitorForEventsMatchingMask_handler.
            unsafe { NSEvent::removeMonitor(&monitor) };
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swipe_directions_match_intellij() {
        // NSEvent.h: -1 is a physical swipe right; +1 is a swipe left.
        assert_eq!(swipe_direction(-1.0, 0.0), Some("back"));
        assert_eq!(swipe_direction(1.0, 0.0), Some("forward"));
    }

    #[test]
    fn vertical_diagonal_and_invalid_swipes_do_not_navigate() {
        for (x, y) in [
            (0.0, 1.0),
            (0.0, -1.0),
            (0.0, 0.0),
            (1.0, 1.0),
            (f64::NAN, 0.0),
            (1.0, f64::INFINITY),
        ] {
            assert_eq!(swipe_direction(x, y), None);
        }
    }
}
