'use strict';

class BeerDiaryCloud {
  constructor(config) {
    this.url = String(config?.supabaseUrl || '').replace(/\/$/, '');
    this.key = String(config?.supabasePublishableKey || '');
    this.client = null;
    this.session = null;
    this.membership = null;
    this.members = new Map();
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

  async resetPassword(email) {
    const { error } = await this.client.auth.resetPasswordForEmail(email, {
      redirectTo: `${location.origin}${location.pathname}`
    });
    if (error) throw error;
  }

  async ResetPassword(email) {
    return this.resetPassword(email);
  }

  async updatePassword(password) {
    const { data, error } = await this.client.auth.updateUser({ password });
    if (error) throw error;
    return data;
  }

  async signOut() {
    this.unsubscribe();
    const { error } = await this.client.auth.signOut();
    if (error) throw error;
    this.session = null;
    this.membership = null;
    this.members.clear();
  }

  async loadMembership() {
    if (!this.session?.user) return null;
    const { data, error } = await this.client
      .from('household_members')
      .select('household_id, display_name, role, households(id, name, invite_code)')
      .eq('user_id', this.session.user.id)
      .maybeSingle();
    if (error) throw error;
    this.membership = data;
    if (data) await this.loadMembers();
    return data;
  }

  async loadMembers() {
    const { data, error } = await this.client
      .from('household_members')
      .select('user_id, display_name')
      .eq('household_id', this.membership.household_id);
    if (error) throw error;
    this.members = new Map((data || []).map(item => [item.user_id, item.display_name]));
    return this.members;
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
    const { data, error } = await this.client
      .from('beer_entries')
      .select('*')
      .eq('household_id', this.membership.household_id)
      .order('client_updated_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async uploadPhoto(entry) {
    if (!entry.photo) return null;
    const blob = await (await fetch(entry.photo)).blob();
    const path = `${this.membership.household_id}/${this.session.user.id}/${entry.id}.jpg`;
    const { error } = await this.client.storage.from('beer-labels').upload(path, blob, {
      contentType: 'image/jpeg',
      cacheControl: '3600',
      upsert: true
    });
    if (error) throw error;
    return path;
  }

  async downloadPhoto(path) {
    if (!path) return null;
    const { data, error } = await this.client.storage.from('beer-labels').download(path);
    if (error) throw error;
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
      await this.client.storage.from('beer-labels').remove([knownPhotoPath]);
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
    const request = existsRemotely
      ? this.client.from('beer_entries').update(row).eq('id', entry.id)
      : this.client.from('beer_entries').insert(row);
    const { error } = await request;
    if (error) throw error;
    return { ...row, photo_path: photoPath };
  }

  async deleteEntry(id, updatedAt) {
    const { error } = await this.client
      .from('beer_entries')
      .update({ deleted_at: new Date().toISOString(), client_updated_at: updatedAt, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) throw error;
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
