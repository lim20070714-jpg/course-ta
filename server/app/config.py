from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    data_dir: Path = Path("data")

    llm_api_key: str = ""
    llm_base_url: str = "https://api.deepseek.com/v1"
    llm_model: str = "deepseek-chat"

    embedding_api_key: str = ""
    embedding_base_url: str = ""
    embedding_model: str = "text-embedding-v3"

    top_k: int = 6
    chunk_size: int = 500
    chunk_overlap: int = 80

    @property
    def embed_base_url(self) -> str:
        return self.embedding_base_url or self.llm_base_url

    @property
    def embed_api_key(self) -> str:
        return self.embedding_api_key or self.llm_api_key


settings = Settings()
