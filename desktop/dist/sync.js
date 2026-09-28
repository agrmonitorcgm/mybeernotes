'use strict';

function isAbortLike(error) {
  const value = String(error?.message || error || '');
  return error?.name === 'AbortError' || /aborterror|signal is aborted|aborted without reason/i.test(value);
}

class BeerDiaryCloud {
  constructor(config) {
    this.url = String(config?.supabaseUrl || '').replace(/\/$/, '');
    this.key = String(config?.supabasePublishableKey || '');
    this.client = null;
    this.session = null;
    this.membership = null;
    this.members = new Map();
    this.memberAvatarPaths = new Map();
    this.memberAvatars = new Map();
    this.memberAvatarLoadedPaths = new Map();
    this.profile = null;
    this.channel = null;
  }

  get configured() {
    return /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(this.url) && this.key.length > 20;
  }

  async loadSdk() {
    if (window.supabase?.createClient) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(Error('Не удалось загрузить модуль синхронизации.'));
      document.head.append(script);
    });
  }

  async init(onAuthChange) {
    if (!this.configured) return false;
    await this.loadSdk();
    this.client = window.supabase.createClient(this.url, this.key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    this.client.auth.onAuthStateChange((event, session) => {
      this.session = session;
      setTimeout(() => onAuthChange?.(event, session), 0);
    });
    const { data, error } = await this.client.auth.getSession();
    if (error) throw error;
    this.session = data.session;
    return true;
  }

  async signIn(email, password) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.session = data.session;
    return data;
  }

  async signUp(email, password, displayName) {
    const { data, error } = await this.client.auth.signUp({
      email,
      password,
      options: {
        data: { display_name: displayName },
        emailRedirectTo: `${location.origin}${location.pathname}`
      }
    });
    if (error) throw error;
    this.session = data.session;
    return data;
  }

  async authRequest(path, options, timeoutMs = 45000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.url}/auth/v1/${path}`, {
        ...options,
        headers: {
          apikey: this.key,
          'Content-Type': 'application/json',
          ...(options?.headers || {})
        },
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(data.msg || data.message || data.error_description || data.error || `Ошибка сервера ${response.status}`);
      return data;
    } catch (error) {
      if (isAbortLike(error)) throw Error('Сервер Supabase отвечает слишком долго. Попробуйте ещё раз через минуту.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async resetPassword(email) {
    const redirectTo = `${location.origin}${location.pathname}`;
    await this.authRequest(`recover?redirect_to=${encodeURIComponent(redirectTo)}`, {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  }

  async ResetPassword(email) {
    return this.resetPassword(email);
  }

  async updatePassword(password) {
    const token = this.session?.access_token;
    if (!token) throw Error('Ссылка восстановления устарела. Запросите новое письмо.');
    const payload = await this.authRequest('user', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ password })
    });
    const user = payload.user || payload;
    if (this.session) this.session = { ...this.session, user };
    return { user };
  }

  async signOut() {
    this.unsubscribe();
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
    this.session = null;
    this.membership = null;
    this.profile = null;
    this.members.clear();
    this.memberAvatarPaths.clear();
    this.memberAvatars.clear();
    this.memberAvatarLoadedPaths.clear();
  }

  async dataRequest(request, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const pending = typeof request.abortSignal === 'function' ? request.abortSignal(controller.signal) : request;
      const result = await pending;
      if (result.error) throw result.error;
      return result.data;
    } catch (error) {
      if (isAbortLike(error)) throw Error('Синхронизация не получила ответ от Supabase. Записи сохранены на устройстве — попробуйте ещё раз через минуту.');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async promiseRequest(request, timeoutMs = 15000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('Сервер Supabase отвечает слишком долго. Данные сохранены на устройстве.')), timeoutMs);
    });
    try {
      const result = await Promise.race([request, timeout]);
      if (result?.error) throw result.error;
      return result?.data;
    } finally {
      clearTimeout(timer);
    }
  }

  async loadMembership() {
    if (!this.session?.user) return null;
    const data = await this.dataRequest(this.client
      .from('household_members')
      .select('household_id, display_name, role, households(id, name, invite_code)')
      .eq('user_id', this.session.user.id)
      .maybeSingle());
    this.membership = data;
    return data;
  }

  async loadMembers() {
    let data;
    try {
      data = await this.dataRequest(this.client
        .from('household_members')
        .select('user_id, display_name, avatar_path')
        .eq('household_id', this.membership.household_id));
    } catch (error) {
      if (!/avatar_path|column|schema cache/i.test(String(error?.message || error))) throw error;
      data = await this.dataRequest(this.client
        .from('household_members')
        .select('user_id, display_name')
        .eq('household_id', this.membership.household_id));
    }
    this.members = new Map((data || []).map(item => [item.user_id, item.display_name]));
    this.memberAvatarPaths = new Map((data || []).filter(item => item.avatar_path).map(item => [item.user_id, item.avatar_path]));
    return this.members;
  }

  async loadMemberAvatars() {
    const loaded = new Map([...this.memberAvatars].filter(([userId]) => this.memberAvatarPaths.has(userId)));
    await Promise.all([...this.memberAvatarPaths].map(async ([userId, path]) => {
      if (loaded.has(userId) && this.memberAvatarLoadedPaths.get(userId) === path) return;
      try {
        const avatar = await this.downloadAvatar(path);
        if (avatar) {
          loaded.set(userId, avatar);
          this.memberAvatarLoadedPaths.set(userId, path);
        }
      } catch {
        // Не стираем уже показанный аватар при временной ошибке сети.
      }
    }));
    this.memberAvatars = loaded;
    return loaded;
  }

  async loadProfile() {
    if (!this.session?.user) return null;
    const data = await this.dataRequest(this.client
      .from('profiles')
      .select('display_name, gender, age, birth_country, political_party, avatar_path')
      .eq('user_id', this.session.user.id)
      .maybeSingle());
    this.profile = data;
    return data;
  }

  async downloadAvatar(path) {
    if (!path) return null;
    const data = await this.promiseRequest(this.client.storage.from('profile-avatars').download(path));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || Error('Не удалось прочитать аватар.'));
      reader.readAsDataURL(data);
    });
  }

  async uploadAvatar(dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    const path = `${this.session.user.id}/avatar-${Date.now()}.jpg`;
    await this.promiseRequest(this.client.storage.from('profile-avatars').upload(path, blob, {
      contentType: 'image/jpeg',
      cacheControl: '3600',
      upsert: true
    }));
    return path;
  }

  async saveProfile(profile, avatarData = null, knownAvatarPath = null) {
    const previousAvatarPath = this.profile?.avatar_path || knownAvatarPath || this.memberAvatarPaths.get(this.session.user.id) || null;
    const avatarPath = avatarData ? await this.uploadAvatar(avatarData) : previousAvatarPath;
    const row = {
      user_id: this.session.user.id,
      display_name: profile.displayName,
      gender: profile.gender,
      age: profile.age,
      birth_country: profile.birthCountry,
      political_party: profile.politicalParty,
      avatar_path: avatarPath,
      updated_at: new Date().toISOString()
    };
    const data = await this.dataRequest(this.client.from('profiles').upsert(row).select().single());
    if (this.membership) {
      try{
        await this.dataRequest(this.client.from('household_members').update({ display_name: profile.displayName, avatar_path: avatarPath }).eq('user_id', this.session.user.id));
      }catch(memberError){
        if (!/avatar_path|column|schema cache/i.test(String(memberError?.message || memberError))) throw memberError;
        await this.dataRequest(this.client.from('household_members').update({ display_name: profile.displayName }).eq('user_id', this.session.user.id));
      }
      this.membership.display_name = profile.displayName;
      this.members.set(this.session.user.id, profile.displayName);
      if (avatarPath) this.memberAvatarPaths.set(this.session.user.id, avatarPath);
      if (avatarData) {
        this.memberAvatars.set(this.session.user.id, avatarData);
        this.memberAvatarLoadedPaths.set(this.session.user.id, avatarPath);
      }
    }
    this.profile = data;
    if (avatarData && previousAvatarPath && previousAvatarPath !== avatarPath) {
      this.client.storage.from('profile-avatars').remove([previousAvatarPath]).catch(() => {});
    }
    return data;
  }

  async createDiary(displayName) {
    const { error } = await this.client.rpc('create_shared_diary', { member_name: displayName });
    if (error) throw error;
    return this.loadMembership();
  }

  async joinDiary(code, displayName) {
    const { error } = await this.client.rpc('join_shared_diary', { code, member_name: displayName });
    if (error) throw error;
    return this.loadMembership();
  }

  async listEntries() {
    const data = await this.dataRequest(this.client
      .from('beer_entries')
      .select('*')
      .eq('household_id', this.membership.household_id)
      .order('client_updated_at', { ascending: false }));
    return data || [];
  }

  async uploadPhoto(entry) {
    if (!entry.photo) return null;
    const blob = await (await fetch(entry.photo)).blob();
    const path = `${this.membership.household_id}/${this.session.user.id}/${entry.id}.jpg`;
    await this.promiseRequest(this.client.storage.from('beer-labels').upload(path, blob, {
      contentType: 'image/jpeg',
      cacheControl: '3600',
      upsert: true
    }));
    return path;
  }

  async downloadPhoto(path) {
    if (!path) return null;
    const data = await this.promiseRequest(this.client.storage.from('beer-labels').download(path));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || Error('Не удалось прочитать фотографию.'));
      reader.readAsDataURL(data);
    });
  }

  async upsertEntry(entry, knownPhotoPath = null, existsRemotely = false) {
    const photoPath = entry.photo ? await this.uploadPhoto(entry) : null;
    if (!entry.photo && knownPhotoPath) {
      await this.promiseRequest(this.client.storage.from('beer-labels').remove([knownPhotoPath]));
    }
    const row = {
      id: entry.id,
      household_id: this.membership.household_id,
      created_by: entry.createdBy || this.session.user.id,
      name: entry.name,
      tasting_date: entry.date,
      country: entry.country,
      abv: entry.abv,
      brewery: entry.brewery,
      style: entry.style,
      price: entry.price,
      place: entry.place,
      barcode: entry.barcode || '',
      would_again: entry.wouldAgain,
      rating: entry.rating,
      tags: entry.tags,
      comment: entry.comment,
      photo_path: photoPath,
      photo_source: entry.photoSource,
      client_updated_at: entry.updatedAt,
      deleted_at: null,
      updated_at: new Date().toISOString()
    };
    let request = existsRemotely
      ? this.client.from('beer_entries').update(row).eq('id', entry.id)
      : this.client.from('beer_entries').insert(row);
    let error;
    try {
      await this.dataRequest(request);
    } catch (requestError) {
      error = requestError;
    }
    if (error && /barcode|column|schema cache/i.test(String(error.message || error))) {
      delete row.barcode;
      request = existsRemotely
        ? this.client.from('beer_entries').update(row).eq('id', entry.id)
        : this.client.from('beer_entries').insert(row);
      try {
        await this.dataRequest(request);
        error = null;
      } catch (requestError) {
        error = requestError;
      }
    }
    if (error) throw error;
    return { ...row, photo_path: photoPath };
  }

  async deleteEntry(id, updatedAt) {
    await this.dataRequest(this.client
      .from('beer_entries')
      .update({ deleted_at: new Date().toISOString(), client_updated_at: updatedAt, updated_at: new Date().toISOString() })
      .eq('id', id));
  }

  subscribe(onChange) {
    this.unsubscribe();
    if (!this.membership) return;
    this.channel = this.client
      .channel(`beer-diary-${this.membership.household_id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'beer_entries',
        filter: `household_id=eq.${this.membership.household_id}`
      }, () => onChange?.())
      .subscribe();
  }

  unsubscribe() {
    if (this.channel && this.client) this.client.removeChannel(this.channel);
    this.channel = null;
  }
}

window.BeerDiaryCloud = BeerDiaryCloud;
