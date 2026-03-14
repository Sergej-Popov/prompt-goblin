use std::thread;
use std::time::Duration;

/// Type the full text at once into the currently focused window.
#[tauri::command]
pub fn type_text(text: String) -> Result<(), String> {
    send_text_native(&text)
}

/// Type a chunk of text incrementally (for beta incremental mode).
/// Optionally send backspaces first to erase previous partial text.
#[tauri::command]
pub fn type_text_incremental(text: String, backspaces: u32) -> Result<(), String> {
    // Send backspaces to erase previous partial text
    for _ in 0..backspaces {
        send_backspace_native()?;
    }
    // Small delay between erasing and typing
    if backspaces > 0 {
        thread::sleep(Duration::from_millis(10));
    }
    send_text_native(&text)
}

// ── Windows implementation ──────────────────────────────────────────

#[cfg(target_os = "windows")]
fn send_text_native(text: &str) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
        KEYEVENTF_UNICODE, VIRTUAL_KEY,
    };

    let mut inputs: Vec<INPUT> = Vec::new();

    for c in text.chars() {
        // Encode as UTF-16 (handles surrogate pairs for emoji etc.)
        let mut buf = [0u16; 2];
        let encoded = c.encode_utf16(&mut buf);

        for code_unit in encoded.iter().copied() {
            // Key down
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: code_unit,
                        dwFlags: KEYEVENTF_UNICODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
            // Key up
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: VIRTUAL_KEY(0),
                        wScan: code_unit,
                        dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            });
        }
    }

    if inputs.is_empty() {
        return Ok(());
    }

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };

    if sent == 0 {
        Err("SendInput failed".to_string())
    } else {
        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn send_backspace_native() -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VK_BACK,
    };

    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_BACK,
                    wScan: 0,
                    dwFlags: KEYBD_EVENT_FLAGS(0),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_BACK,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };

    if sent == 0 {
        Err("SendInput failed for backspace".to_string())
    } else {
        Ok(())
    }
}

// ── Stub for non-Windows platforms ──────────────────────────────────

#[cfg(not(target_os = "windows"))]
fn send_text_native(text: &str) -> Result<(), String> {
    Err(
        "Keyboard simulation not implemented for this platform. \
         Contributions welcome: implement using xdotool (Linux) or CGEventPost (macOS)."
            .to_string(),
    )
}

#[cfg(not(target_os = "windows"))]
fn send_backspace_native() -> Result<(), String> {
    Err("Keyboard simulation not implemented for this platform.".to_string())
}
