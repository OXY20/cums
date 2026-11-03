//! 口令哈希、JWT 令牌签发与校验。

use crate::config::ResolvedConfig;
use crate::error::{AppError, AppResult};
use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

/// 角色。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    Teacher,
}

impl Role {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value {
            "admin" => Ok(Role::Admin),
            "teacher" => Ok(Role::Teacher),
            other => Err(AppError::Internal(format!("未知角色：{other}"))),
        }
    }
}

/// JWT 载荷。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    /// 用户 ID
    pub sub: i64,
    /// 用户名
    pub username: String,
    /// 角色
    pub role: Role,
    /// 过期时间（Unix 秒）
    pub exp: i64,
    /// 签发时间（Unix 秒）
    pub iat: i64,
}

/// 使用 Argon2id 计算口令哈希。
pub fn hash_password(plain: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(plain.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("口令哈希失败：{e}"))?;
    Ok(hash.to_string())
}

/// 校验口令是否匹配哈希。
pub fn verify_password(plain: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(plain.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// 为指定用户签发令牌。
pub fn issue_token(
    config: &ResolvedConfig,
    user_id: i64,
    username: &str,
    role: Role,
) -> AppResult<String> {
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        username: username.to_string(),
        role,
        iat: now.timestamp(),
        exp: (now + Duration::hours(config.raw.auth.token_ttl_hours)).timestamp(),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.raw.auth.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("令牌签发失败：{e}")))
}

/// 校验并解析令牌。
pub fn verify_token(config: &ResolvedConfig, token: &str) -> AppResult<Claims> {
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(config.raw.auth.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| AppError::Unauthorized)?;

    Ok(data.claims)
}

/// 文件预览票的有效期（秒）。
///
/// 预览票只是为了让 `<img>` / `<video>` / `<iframe>` 这类
/// **无法携带 Authorization 头**的标签能取到文件，
/// 因此时效必须很短：页面打开后几分钟内够用，泄漏出去也很快失效。
pub const PREVIEW_TICKET_TTL_SECS: i64 = 600;

/// 文件预览票载荷。
///
/// 与登录令牌分开签发：即使预览票被复制到别处，也只能读
/// `resource_id` 对应的那一个文件，且十分钟后自动失效，
/// 不能当作登录令牌去调用其它管理接口。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviewClaims {
    /// 固定为 `preview`，用于和登录令牌区分用途
    pub purpose: String,
    /// 允许读取的资源 ID
    pub res: i64,
    /// 过期时间（Unix 秒）
    pub exp: i64,
}

/// 为单个资源签发短时效预览票。
pub fn issue_preview_ticket(config: &ResolvedConfig, resource_id: i64) -> AppResult<String> {
    let claims = PreviewClaims {
        purpose: "preview".to_string(),
        res: resource_id,
        exp: (Utc::now() + Duration::seconds(PREVIEW_TICKET_TTL_SECS)).timestamp(),
    };

    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(config.raw.auth.jwt_secret.as_bytes()),
    )
    .map_err(|e| AppError::Internal(format!("预览票签发失败：{e}")))
}

/// 校验预览票，并且要求它确实是签给 `resource_id` 的。
pub fn verify_preview_ticket(
    config: &ResolvedConfig,
    resource_id: i64,
    ticket: &str,
) -> AppResult<()> {
    let data = decode::<PreviewClaims>(
        ticket,
        &DecodingKey::from_secret(config.raw.auth.jwt_secret.as_bytes()),
        &Validation::default(),
    )
    .map_err(|_| AppError::Forbidden)?;

    let claims = data.claims;
    if claims.purpose != "preview" || claims.res != resource_id {
        return Err(AppError::Forbidden);
    }

    Ok(())
}
