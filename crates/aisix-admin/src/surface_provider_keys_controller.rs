//! Read handlers for `/admin/v1/provider_keys`: list and get-by-id,
//! same shape as [`crate::surface_models_controller`].

use aisix_core::taxonomy_resource_vo::ResourceEntry;
use aisix_core::ProviderKey;
use axum::extract::{Path, State};
use axum::Json;

use crate::surface_auth_controller::AdminAuth;
use crate::surface_api_error_view::AdminError;
use crate::surface_admin_state_router::AdminState;

pub async fn list_provider_keys(
    _auth: AdminAuth,
    State(state): State<AdminState>,
) -> Result<Json<Vec<ResourceEntry<ProviderKey>>>, AdminError> {
    let entries = state.store.list_provider_keys().await?;
    Ok(Json(entries))
}

pub async fn get_provider_key(
    _auth: AdminAuth,
    Path(id): Path<String>,
    State(state): State<AdminState>,
) -> Result<Json<ResourceEntry<ProviderKey>>, AdminError> {
    let entry = state
        .store
        .get_provider_key(&id)
        .await?
        .ok_or(AdminError::NotFound)?;
    Ok(Json(entry))
}
