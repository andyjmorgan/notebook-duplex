#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn broker_connection() -> Result<serde_json::Value, String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().ok_or("Missing project root")?;
    let text = std::fs::read_to_string(root.join(".runtime/connection.json"))
        .map_err(|_| "Start npm run broker before opening Notebook Duplex.".to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![broker_connection])
        .run(tauri::generate_context!())
        .expect("Notebook Duplex could not start");
}
