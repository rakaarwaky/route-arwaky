//! Read handlers for `/admin/v1/guardrails`: list and get-by-id,
//! same shape as [`crate::surface_models_controller`].

use aisix_core::taxonomy_resource_vo::ResourceEntry;
use aisix_core::Guardrail;
use axum::extract::{Path, State};
use axum::Json;

use crate::surface_auth_controller::AdminAuth;
use crate::surface_api_error_view::AdminError;
use crate::surface_admin_state_router::AdminState;

pub async fn list_guardrails(
    _auth: AdminAuth,
    State(state): State<AdminState>,
) -> Result<Json<Vec<ResourceEntry<Guardrail>>>, AdminError> {
    let entries = state.store.list_guardrails().await?;
    Ok(Json(entries))
}

pub async fn get_guardrail(
    _auth: AdminAuth,
    Path(id): Path<String>,
    State(state): State<AdminState>,
) -> Result<Json<ResourceEntry<Guardrail>>, AdminError> {
    let entry = state
        .store
        .get_guardrail(&id)
        .await?
        .ok_or(AdminError::NotFound)?;
    Ok(Json(entry))
}
