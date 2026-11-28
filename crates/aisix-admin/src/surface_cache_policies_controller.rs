//! Read handlers for `/admin/v1/cache_policies`: list and get-by-id,
//! same shape as [`crate::surface_models_controller`].

use aisix_core::taxonomy_resource_vo::ResourceEntry;
use aisix_core::CachePolicy;
use axum::extract::{Path, State};
use axum::Json;

use crate::surface_auth_controller::AdminAuth;
use crate::surface_api_error_view::AdminError;
use crate::surface_admin_state_router::AdminState;

pub async fn list_cache_policies(
    _auth: AdminAuth,
    State(state): State<AdminState>,
) -> Result<Json<Vec<ResourceEntry<CachePolicy>>>, AdminError> {
    let entries = state.store.list_cache_policies().await?;
    Ok(Json(entries))
}

pub async fn get_cache_policy(
    _auth: AdminAuth,
    Path(id): Path<String>,
    State(state): State<AdminState>,
) -> Result<Json<ResourceEntry<CachePolicy>>, AdminError> {
    let entry = state
        .store
        .get_cache_policy(&id)
        .await?
        .ok_or(AdminError::NotFound)?;
    Ok(Json(entry))
}
